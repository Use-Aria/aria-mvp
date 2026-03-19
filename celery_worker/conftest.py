"""Pytest configuration for celery_worker test suite.

Adds the celery_worker directory to sys.path so that modules like
canvas.*, sms.*, tasks, and celery_app are importable from tests.
"""
import sys
import os

# Ensure celery_worker root is on path for all test imports.
sys.path.insert(0, os.path.dirname(__file__))
