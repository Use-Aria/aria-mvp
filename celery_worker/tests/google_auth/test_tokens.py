"""Tests for google_auth.tokens — store/load with Fernet encryption."""
import os
import pytest
from unittest.mock import MagicMock, patch
from cryptography.fernet import Fernet


@pytest.fixture(autouse=True)
def set_encryption_key(monkeypatch):
    """Set a valid Fernet key for all tests in this module."""
    key = Fernet.generate_key().decode()
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", key)


@pytest.fixture
def mock_supabase():
    """Return a mock Supabase client for all tokens tests."""
    mock_client = MagicMock()
    with patch("google_auth.tokens._get_supabase", return_value=mock_client):
        yield mock_client


def test_store_google_tokens_writes_encrypted_values(mock_supabase):
    """store_google_tokens should write encrypted (not plaintext) tokens to integrations."""
    from google_auth.tokens import store_google_tokens

    user_id = "user-abc-123"
    access = "access_token_plain"
    refresh = "refresh_token_plain"

    # Simulate upsert call
    mock_supabase.table.return_value.upsert.return_value.execute.return_value = MagicMock()

    store_google_tokens(user_id, access, refresh)

    # Verify upsert was called
    assert mock_supabase.table.called
    call_args = mock_supabase.table.return_value.upsert.call_args
    upserted_data = call_args[0][0]

    # Tokens must not be stored as plaintext
    assert upserted_data["access_token"] != access
    assert upserted_data["refresh_token"] != refresh
    # Tokens must be strings (base64 encoded ciphertext)
    assert isinstance(upserted_data["access_token"], str)
    assert isinstance(upserted_data["refresh_token"], str)
    # platform must be google
    assert upserted_data["platform"] == "google"
    assert upserted_data["user_id"] == user_id


def test_load_google_tokens_returns_decrypted(mock_supabase):
    """load_google_tokens should return decrypted {access_token, refresh_token}."""
    from google_auth.encryption import encrypt_token
    from google_auth.tokens import load_google_tokens

    access_plain = "access_token_plain"
    refresh_plain = "refresh_token_plain"

    # Simulate DB returning encrypted values
    mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value = MagicMock(
        data=[{
            "access_token": encrypt_token(access_plain),
            "refresh_token": encrypt_token(refresh_plain),
        }]
    )

    result = load_google_tokens("user-abc-123")

    assert result is not None
    assert result["access_token"] == access_plain
    assert result["refresh_token"] == refresh_plain


def test_load_google_tokens_returns_none_when_not_found(mock_supabase):
    """load_google_tokens returns None when no Google integration exists."""
    from google_auth.tokens import load_google_tokens

    mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value = MagicMock(
        data=[]
    )

    result = load_google_tokens("nonexistent-user")
    assert result is None
