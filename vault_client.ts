import * as anchor from "@anchor-lang/core";
import { Program, AnchorProvider, Wallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram, clusterApiUrl } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, getAccount, getMint } from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// IDL создаётся командой `anchor build` (описывает интерфейс программы)
const idl = JSON.parse(
  fs.readFileSync(path.join(__dirname, "target/idl/liquidity_vault.json"), "utf-8")
);

const addr = (a: PublicKey | string) => `https://explorer.solana.com/address/${a.toString()}?cluster=devnet`;
const tx = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;

async function main() {
  // 1. Devnet + кошелёк из Solana CLI (файл ключа остаётся вне репозитория)
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const secretKeyPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(secretKeyPath, "utf-8")));
  const admin = Keypair.fromSecretKey(secretKey);
  console.log("Администратор / пользователь:", admin.publicKey.toBase58());

  const provider = new AnchorProvider(connection, new Wallet(admin), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl as any, provider);
  const programId = new PublicKey(idl.address);
  console.log("Program ID:", programId.toBase58());

  // 2. Токен, который vault будет принимать (обычный SPL-токен, 6 decimals).
  // Создаётся один раз, адрес хранится в deposit_mint.txt (это публичный адрес, не ключ).
  const mintFile = path.join(__dirname, "deposit_mint.txt");
  let depositMint: PublicKey;
  if (fs.existsSync(mintFile)) {
    depositMint = new PublicKey(fs.readFileSync(mintFile, "utf-8").trim());
    console.log("Deposit mint (уже есть):", depositMint.toBase58());
  } else {
    depositMint = await createMint(connection, admin, admin.publicKey, null, 6);
    fs.writeFileSync(mintFile, depositMint.toBase58());
    console.log("Deposit mint создан:", depositMint.toBase58());
  }

  // 3. Вычисляем все PDA — те же seeds, что в программе (lib.rs)
  const [vaultConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), admin.publicKey.toBuffer(), depositMint.toBuffer()],
    programId
  );
  const [shareMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("share_mint"), vaultConfig.toBuffer()],
    programId
  );
  const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_token"), vaultConfig.toBuffer()],
    programId
  );
  const [userPosition] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), vaultConfig.toBuffer(), admin.publicKey.toBuffer()],
    programId
  );

  // 4. create_vault. Сначала проверяем, не создан ли vault уже: при сетевом сбое
  // повторный запуск не отправит транзакцию второй раз.
  let createSig = "(уже был создан раньше)";
  if (!(await connection.getAccountInfo(vaultConfig))) {
    console.log("\n--- create_vault ---");
    createSig = await program.methods
      .createVault()
      .accounts({
        admin: admin.publicKey,
        depositMint,
        vaultConfig,
        shareMint,
        vaultTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("Транзакция:", tx(createSig));
  } else {
    console.log("\nVault уже существует, create_vault пропускаем.");
  }

  // 5. open_position — карточка пользователя
  let positionSig = "(уже была создана раньше)";
  if (!(await connection.getAccountInfo(userPosition))) {
    console.log("\n--- open_position ---");
    positionSig = await program.methods
      .openPosition()
      .accounts({
        user: admin.publicKey,
        vaultConfig,
        userPosition,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("Транзакция:", tx(positionSig));
  } else {
    console.log("\nКарточка уже существует, open_position пропускаем.");
  }

  // 6. Читаем состояние прямо из блокчейна и проверяем, кто чем владеет
  const cfg = await (program.account as any).vaultConfig.fetch(vaultConfig);
  const pos = await (program.account as any).userPosition.fetch(userPosition);
  const share = await getMint(connection, shareMint);
  const vaultToken = await getAccount(connection, vaultTokenAccount);

  console.log("\n=== VaultConfig ===");
  console.log("admin:              ", cfg.admin.toBase58());
  console.log("deposit_mint:       ", cfg.depositMint.toBase58());
  console.log("share_mint:         ", cfg.shareMint.toBase58());
  console.log("vault_token_account:", cfg.vaultTokenAccount.toBase58());
  console.log("total_deposited:    ", cfg.totalDeposited.toString());

  console.log("\n=== Кто чем владеет ===");
  console.log("share mint authority:  ", share.mintAuthority?.toBase58(), share.mintAuthority?.equals(vaultConfig) ? "(= VaultConfig PDA)" : "(!)");
  console.log("vault token owner:     ", vaultToken.owner.toBase58(), vaultToken.owner.equals(vaultConfig) ? "(= VaultConfig PDA)" : "(!)");

  console.log("\n=== UserPosition ===");
  console.log("owner:            ", pos.owner.toBase58());
  console.log("vault:            ", pos.vault.toBase58());
  console.log("deposited_amount: ", pos.depositedAmount.toString());

  // 7. Готовый блок со ссылками для README
  const md = [
    "## Адреса в Devnet",
    "",
    "| Аккаунт | Адрес |",
    "|---|---|",
    `| Программа | [${programId}](${addr(programId)}) |`,
    `| Deposit mint | [${depositMint}](${addr(depositMint)}) |`,
    `| VaultConfig (PDA) | [${vaultConfig}](${addr(vaultConfig)}) |`,
    `| Share mint (PDA) | [${shareMint}](${addr(shareMint)}) |`,
    `| Vault token account (PDA) | [${vaultTokenAccount}](${addr(vaultTokenAccount)}) |`,
    `| UserPosition (PDA) | [${userPosition}](${addr(userPosition)}) |`,
    "",
    "## Транзакции",
    "",
    `- create_vault: ${createSig.startsWith("(") ? createSig : tx(createSig)}`,
    `- open_position: ${positionSig.startsWith("(") ? positionSig : tx(positionSig)}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(__dirname, "addresses.md"), md);
  console.log("\nСсылки для README сохранены в addresses.md");
}

main().catch((err) => {
  console.error("Ошибка:", err);
  process.exit(1);
});