"""Tests for google_auth.encryption — Fernet token encrypt/decrypt."""
import os
import pytest
from cryptography.fernet import Fernet


@pytest.fixture(autouse=True)
def set_encryption_key(monkeypatch):
    """Set a valid Fernet key for all tests in this module."""
    key = Fernet.generate_key().decode()
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", key)


def test_encrypt_token_returns_nonempty_string():
    """encrypt_token should return a non-empty string."""
    from google_auth.encryption import encrypt_token

    result = encrypt_token("test_token_123")
    assert isinstance(result, str)
    assert len(result) > 0


def test_encrypt_token_different_from_input():
    """encrypt_token should not return plaintext."""
    from google_auth.encryption import encrypt_token

    result = encrypt_token("test_token_123")
    assert result != "test_token_123"


def test_decrypt_round_trip():
    """decrypt_token(encrypt_token(x)) should return x."""
    from google_auth.encryption import encrypt_token, decrypt_token

    plaintext = "test_token_123"
    assert decrypt_token(encrypt_token(plaintext)) == plaintext


def test_encrypt_nondeterministic():
    """Fernet includes a timestamp — two encryptions of the same token must differ."""
    from google_auth.encryption import encrypt_token

    c1 = encrypt_token("test_token_123")
    c2 = encrypt_token("test_token_123")
    assert c1 != c2
