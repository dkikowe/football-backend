# Currency store and Apple consumables

Implementation prepared 2026-11-11. Apple consumable drafts now exist: 80 Gems (6833422799, US $4.99) and 180 Gems (6833425138, US $9.99). Paid Apps Agreement was verified In Effect; no agreement acceptance, banking or tax changes were performed. Production deployment is being verified; consult `AppStore/2026-11-11-monetization-preparation/backend-deployment.json` for the final deployment result. Apple payments remain **disabled**; real Apple purchases have not been tested. Coin exchange becomes available to authenticated existing accounts after the backend rollout.

## Catalog

| Apple consumable product ID | Gems | Proposed US base price |
| --- | ---: | ---: |
| `com.krutyev.arcadefootball.gems.80` | 80 | $4.99 |
| `com.krutyev.arcadefootball.gems.180` | 180 | $9.99 |

Prices are configured in App Store Connect. The game must display localized StoreKit metadata; these USD amounts are preparation values, not prices returned by this API.

| Exchange pack | Gem cost | Coins |
| --- | ---: | ---: |
| `coins.1000` | 20 | 1,000 |
| `coins.5000` | 90 | 5,000 |

## API contract

All `/v1/store` routes require the normal bearer session except signed Apple notifications. Strict JSON schemas reject extra client currency, price, player or reward fields.

- `GET /v1/store/catalog`: `{ applePurchasesEnabled, environment, requireLinkedAccount:true, gemPacks:[{productId,gems}], coinPacks:[{id,coins,gems}] }`.
- `POST /v1/store/exchange`: `{ packId, requestId }`; a UUID request ID belongs to one account and pack. Persist/reuse it after an ambiguous network response. Returns the existing `OnlinePlayer` profile. The server locks the wallet and commits debit + credit + idempotency ledger atomically.
- `POST /v1/store/apple/fulfill`: `{ signedTransaction }` with StoreKit 2 JWS from `OrderInfo.Apple.jwsRepresentation`. Returns `{ transactionId, productId, gems, alreadyGranted, profile }`. Set StoreKit `appAccountToken` to the current player UUID **before purchase**; preserve the originating account when retrying. Require a linked Apple/email account before opening a purchase. Confirm/finish the StoreKit order only after this endpoint acknowledges delivery. Do not grant paid currency through PlayerPrefs, pending UI, cancelled/deferred callbacks or client-reported price.
- `POST /v1/store/apple/notifications`: `{ signedPayload }`, App Store Server Notifications **V2**, no bearer token. Both outer notification and nested transaction are verified with Apple's SDK. Register its HTTPS URL in App Store Connect, separately for production and sandbox. `REFUND`, `REVOKE`, `REFUND_REVERSED` adjust the ledger once, including out-of-order/repeated deliveries. Unknown signed events are recorded without wallet mutation; consumption-reporting to Apple is not implemented.

## Configuration and rollout

- `APPLE_IAP_ENABLED=false`: new-sales availability advertised to clients.
- `APPLE_IAP_FULFILLMENT_ENABLED=false`: allow first credit of verified paid orders. Must be true before new sales may be enabled. After launch, disabling new sales should normally **leave fulfillment enabled** so already-paid/pending orders can finish. Already granted verified transactions remain replayable even with this switch off, without new credit.
- `APPLE_IAP_ENVIRONMENT=Production`: only this Apple environment accepted. **Never auto-fallback from production to sandbox on the same wallet database.**
- Sandbox requires a **separate deployment, PostgreSQL database, Redis namespace and test client endpoint**, `NODE_ENV=test` (or development), `APPLE_IAP_ENVIRONMENT=Sandbox`, and `APPLE_IAP_SANDBOX_ISOLATED=true`. The server refuses Sandbox under production NODE_ENV. Apple routes sandbox notifications to the production notification URL when the sandbox URL is blank; this API deliberately rejects that environment mismatch. Configure a separate sandbox URL before device purchase testing. Infrastructure must enforce physical database separation; the flag is an explicit operator assertion, not database provisioning.

Signed notifications are still verified/processed when sales or delivery are switched off, so a sales pause does not disable refund bookkeeping. The code never accepts a client environment override, Xcode/Fake Store receipt, unsigned JWT or self-supplied root certificate. The official Apple library uses bundled public Apple trust roots with online revocation checks. No App Store private key is required for this verification path; polling App Store transaction/notification history is not implemented.

Migration `004_currency_store.sql` is additive: defaults leave existing wallets unchanged. It adds one debt column, currency exchange ledger, globally unique `(environment,transaction_id)` purchase records, notification deduplication and a wallet trigger. On a refund, unspent gems are reclaimed; spent gems become nonnegative debt. Future earned or purchased gems settle that debt before becoming spendable. This avoids negative wallet balances or duplicate currency. Purchases are globally bound to their signed app account token; account deletion clears the profile FK while retaining only transaction identifiers, product/amount/time and a hashed app account token for fraud prevention. Update public privacy disclosures and retention policy before shipping paid purchases.

## Required launch checks

1. Verify Paid Apps Agreement remains In Effect (already confirmed on 2026-11-11). Account Holder verifies/completes any required tax and banking information personally. Existing publisher remains the merchant; this integration does not change payout beneficiaries.
2. Complete/review the two existing consumable drafts, localization and review screenshots; verify their final store availability. Do not expose StoreKit purchase buttons until metadata loads.
3. Use isolated Apple Sandbox and a real iPhone to test success, cancellation, Ask to Buy/deferred, network loss before/after durable credit, app restart, device/account switch, duplicate callbacks, refunds and notifications.
4. Configure and verify V2 notification delivery. Review signed notification errors/delivery retries; operational recovery of missed notifications is currently manual via Apple history. Monitor without logging JWS, bearer tokens or personal banking data.
5. Update App Store privacy/support and submit the first IAPs with a new app version as Apple requires. Do not replace/cancel a current review simply to prepare these drafts.
6. Only then enable fulfillment and sales on the production deployment.

## Verification

`npm run test:currency` uses a disposable real PostgreSQL database; it never reads `.env.local`, contacts the deployed API or makes StoreKit charges. Covers atomic exchange retries/concurrency, strict API schemas, forged signature rejection through Apple's verifier, claim validation, duplicate grants, account binding, linked-account requirement, disabled delivery, refund-before-grant, reversals/out-of-order notifications, refund debt, earned-gem debt settlement and deleted-account replay. Positive cryptographic Apple Sandbox verification still requires Apple's signed device transaction; test fixtures never bypass the public API.

Official sources:
- https://github.com/apple/app-store-server-library-node
- https://apple.github.io/app-store-server-library-node/classes/SignedDataVerifier.html
- https://www.apple.com/certificateauthority/
- https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase/
