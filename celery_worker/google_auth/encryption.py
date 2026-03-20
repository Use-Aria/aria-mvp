"""Fernet-based encryption for Google OAuth tokens.

All tokens are encrypted before writing to Supabase and decrypted on load.
The TOKEN_ENCRYPTION_KEY environment variable must contain a valid Fernet key.

Generate a key with:
    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
"""
import os

from cryptography.fernet import Fernet


def get_fernet() -> Fernet:
    """Return a Fernet instance using TOKEN_ENCRYPTION_KEY from environment.

    Returns:
        Fernet instance ready for encrypt/decrypt operations.

    Raises:
        KeyError: If TOKEN_ENCRYPTION_KEY is not set.
        ValueError: If TOKEN_ENCRYPTION_KEY is not a valid Fernet key.
    """
    key = os.environ["TOKEN_ENCRYPTION_KEY"]
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt_token(token: str) -> str:
    """Encrypt a plaintext OAuth token using Fernet symmetric encryption.

    Fernet encryption includes a timestamp, so the same plaintext produces
    a different ciphertext on each call (non-deterministic).

    Args:
        token: Plaintext OAuth token string.

    Returns:
        Base64-encoded Fernet ciphertext string. Safe to store in DB.
    """
    f = get_fernet()
    return f.encrypt(token.encode()).decode()


def decrypt_token(encrypted: str) -> str:
    """Decrypt a Fernet-encrypted OAuth token back to plaintext.

    Args:
        encrypted: Base64-encoded Fernet ciphertext string (from encrypt_token).

    Returns:
        Plaintext OAuth token string.

    Raises:
        cryptography.fernet.InvalidToken: If the token is tampered or key is wrong.
    """
    f = get_fernet()
    return f.decrypt(encrypted.encode()).decode()
