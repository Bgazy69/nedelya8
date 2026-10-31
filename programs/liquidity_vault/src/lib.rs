use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

// Временный ID: команда `anchor keys sync` заменит его на настоящий ID программы.
declare_id!("81Twbdtp8aSVkfUi3MRmjTAQgsCggdsWiAr2QiU3CDP1");

/// Liquidity Vault — неделя 8: каркас (скелет) хранилища.
///
/// Денег пока нет — только структура аккаунтов:
///   1. VaultConfig       — настройки vault (PDA программы)
///   2. share mint        — токен-квитанция (PDA, mint authority = VaultConfig)
///   3. vault token acc.  — хранилище внесённых токенов (PDA, authority = VaultConfig)
///   4. UserPosition      — «карточка» пользователя (PDA от адреса пользователя)
///
/// Главная идея: программа сама владеет деньгами через PDA — у PDA нет приватного
/// ключа, поэтому ни администратор, ни кто-либо другой не может просто забрать токены.
#[program]
pub mod liquidity_vault {
    use super::*;

    /// Создаёт vault. Вызывается один раз: создаёт настройки, share-токен и хранилище.
    pub fn create_vault(ctx: Context<CreateVault>) -> Result<()> {
        let config = &mut ctx.accounts.vault_config;
        config.admin = ctx.accounts.admin.key();
        config.deposit_mint = ctx.accounts.deposit_mint.key();
        config.share_mint = ctx.accounts.share_mint.key();
        config.vault_token_account = ctx.accounts.vault_token_account.key();
        config.total_deposited = 0;
        config.bump = ctx.bumps.vault_config;

        msg!("Vault создан. Администратор: {}", config.admin);
        Ok(())
    }

    /// Создаёт «карточку» пользователя. Адрес карточки вычисляется из адреса
    /// пользователя, поэтому её всегда можно найти без списка всех пользователей.
    pub fn open_position(ctx: Context<OpenPosition>) -> Result<()> {
        let position = &mut ctx.accounts.user_position;
        position.owner = ctx.accounts.user.key();
        position.vault = ctx.accounts.vault_config.key();
        position.deposited_amount = 0;
        position.bump = ctx.bumps.user_position;

        msg!("Карточка создана для {}", position.owner);
        Ok(())
    }
}

/// Настройки vault: кто администратор, какой токен принимаем, какой share-токен,
/// где лежит хранилище и сколько всего внесено.
#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    pub admin: Pubkey,
    pub deposit_mint: Pubkey,
    pub share_mint: Pubkey,
    pub vault_token_account: Pubkey,
    pub total_deposited: u64,
    pub bump: u8,
}

/// Карточка пользователя: чей это vault-аккаунт и сколько пользователь внёс.
#[account]
#[derive(InitSpace)]
pub struct UserPosition {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub deposited_amount: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct CreateVault<'info> {
    /// Администратор: подписывает создание и платит rent за новые аккаунты.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Токен, который vault будет принимать (обычный SPL-токен).
    pub deposit_mint: Account<'info, Mint>,

    /// Настройки vault. PDA: ["vault", admin, deposit_mint].
    #[account(
        init,
        payer = admin,
        space = 8 + VaultConfig::INIT_SPACE,
        seeds = [b"vault", admin.key().as_ref(), deposit_mint.key().as_ref()],
        bump
    )]
    pub vault_config: Account<'info, VaultConfig>,

    /// Share-токен (квитанция). PDA: ["share_mint", vault_config].
    /// Mint authority — сам VaultConfig, значит выпускать share-токены
    /// может только программа, а не человек.
    #[account(
        init,
        payer = admin,
        seeds = [b"share_mint", vault_config.key().as_ref()],
        bump,
        mint::decimals = deposit_mint.decimals,
        mint::authority = vault_config,
    )]
    pub share_mint: Account<'info, Mint>,

    /// Хранилище внесённых токенов. PDA: ["vault_token", vault_config].
    /// Владелец (authority) — VaultConfig, значит двигать токены может только программа.
    #[account(
        init,
        payer = admin,
        seeds = [b"vault_token", vault_config.key().as_ref()],
        bump,
        token::mint = deposit_mint,
        token::authority = vault_config,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    /// Пользователь: подписывает и платит rent за свою карточку.
    #[account(mut)]
    pub user: Signer<'info>,

    /// Vault, в котором пользователь открывает карточку.
    pub vault_config: Account<'info, VaultConfig>,

    /// Карточка пользователя. PDA: ["position", vault_config, user].
    #[account(
        init,
        payer = user,
        space = 8 + UserPosition::INIT_SPACE,
        seeds = [b"position", vault_config.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_position: Account<'info, UserPosition>,

    pub system_program: Program<'info, System>,
}