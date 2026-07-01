"""Generate a bcrypt hash to paste into .env's ADMIN_PASSWORD_HASH.

Usage: python scripts/hash_password.py
Then paste the output into ADMIN_PASSWORD_HASH= in .env
"""
import getpass
import sys
from pathlib import Path

# Allow running without installing the app package
sys.path.insert(0, str(Path(__file__).parent.parent))

from passlib.hash import bcrypt


def main():
    pw = getpass.getpass("New admin password: ")
    confirm = getpass.getpass("Confirm: ")
    if pw != confirm:
        print("Passwords do not match.")
        sys.exit(1)
    if len(pw) < 10:
        print("Password must be at least 10 characters.")
        sys.exit(1)
    print("\nHash — paste into .env as ADMIN_PASSWORD_HASH=:\n")
    print(bcrypt.hash(pw))


if __name__ == "__main__":
    main()
