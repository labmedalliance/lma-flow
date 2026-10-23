"""Print a password hash for FLOW_PASSWORD_HASH. Usage: uv run python -m flow_hash"""

from getpass import getpass

from werkzeug.security import generate_password_hash

if __name__ == "__main__":
    password = getpass("Passwort: ")
    if password != getpass("Wiederholen: "):
        raise SystemExit("Passwörter stimmen nicht überein.")
    print(generate_password_hash(password))
