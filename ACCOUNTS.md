# Persistent accounts and economy

Apple, email/password and guest use the existing player ID, session and match service. A guest can register an email or a new Apple identity without changing player ID. Existing identities sign in to their own account; no email-based merging or client balance import is performed. Email is unverified; recovery is intentionally unavailable in this release.

## Server authority
- PostgreSQL migration 002 adds identities, inventory, gems, quest receipts, private age/onboarding and refresh-token families. It grants the 1000-coin starter balance once, preserves server-earned coins and the previously selected character. Legacy device-only balances remain in the old local save; they are not trusted/imported.
- New accounts start with 1000 coins and 0 gems, Kai/Leo/Ryan/classic kit.
- Verified match rewards: win 60 coins/100 XP/3 gems; draw 40/60/2; loss 30/60/1. The existing immutable match result transaction prevents replay rewards.
- Purchases use canonical prices and a locked balance row. Inventory has a unique player/item key. Quest eligibility comes from server match records with UTC periods and unique receipts.
- All profile, queue and room character selections check ownership.

## Authentication
Email passwords use random salts and asynchronous scrypt N=32768,r=8,p=3; maximum four simultaneous hashes, per-identity and IP throttles. Opaque access tokens are held in Redis; hashed rotating refresh tokens in PostgreSQL. Logout revokes the current refresh family and access token. A refresh retry cannot resurrect a revoked family.

Apple requests use one-use, five-minute nonce challenges bound to the guest session. jose verifies Apple RS256 signature/JWKS, issuer, app audience, expiry, subject and nonce. Authorization codes are exchanged server-side. Apple refresh tokens are AES-256-GCM encrypted and revoked before account deletion. No token/password is logged. Never commit Apple keys or account encryption keys.

Production configuration: APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (PKCS8), ACCOUNT_ENCRYPTION_KEY (64 hex characters). The native iOS app requires Sign in with Apple entitlement and AuthenticationServices/Security frameworks. Refresh credentials use iOS Keychain. Development desktop sessions remain in private app storage.

## Validation
`npm test`: real isolated PostgreSQL/Redis tests cover guest linking, login, restart persistence, hashing, wrong credentials, cross-account isolation, concurrent purchases and claims, insufficient funds, ownership, logout, deletion, and existing multiplayer result replay. Apple signature tests use a generated test RSA key and reject forged, expired, wrong-audience and wrong-nonce tokens. A real Apple authorization sheet must also be exercised on a signed iPhone build.

Before public release: update App Store privacy disclosures for account email/private age. Password recovery/email verification are not implemented by user request. Back up production PostgreSQL and the account encryption key with operational retention appropriate to release; loss of the key prevents Apple token revocation. Do not treat unit/integration tests as a completed security audit.
