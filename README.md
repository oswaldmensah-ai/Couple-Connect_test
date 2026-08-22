# Couple Connect

A small private web app for two people.

## Features
- Two-user login.
- Private messages.
- A sender can protect a message with:
  - **Photo proof**: the reader sends a photo to the sender; the sender approves it before the message is revealed.
  - **Question**: the reader answers a question; a correct answer reveals the message.
  - **Either**: the reader can use either method.
- Saved plans with date, time, place, notes and completion status.
- Real-time message/plan refresh using Socket.IO.
- SQLite database for persistent storage.

## Run it

1. Install Node.js 18+.
2. Open this folder in a terminal.
3. Run:
   `npm install`
4. Copy `.env.example` to `.env` and change the two names/passwords.
5. Run:
   `npm start`
6. Open:
   `http://localhost:3000`

For use across the internet, deploy the app behind HTTPS and use a secure SESSION_SECRET.

## Important
This project treats an uploaded picture as **proof requested by the sender**, not biometric identity verification. It does not use facial recognition.

The default app is intentionally simple. For a public deployment, add stronger authentication, rate limiting, CSRF protection, secure cookie settings, encrypted/private object storage, image-size/type validation, backups and HTTPS.
