# Apple App Store trust roots

Public DER certificates downloaded from Apple's PKI directory, 2026-11-11:

- https://www.apple.com/appleca/AppleIncRootCertificate.cer
- https://www.apple.com/certificateauthority/AppleRootCA-G2.cer
- https://www.apple.com/certificateauthority/AppleRootCA-G3.cer

Source: https://www.apple.com/certificateauthority/

These are public trust roots, not signing keys. `SignedDataVerifier` validates the signed chain against these roots with online revocation checks enabled. Never substitute the root supplied inside an untrusted receipt. Review Apple's published root changes before updating.
