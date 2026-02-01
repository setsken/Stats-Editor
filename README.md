# OF Stats Backend

Backend API for OF Stats Editor Pro Chrome Extension.

## Features

- User authentication (register/login)
- Subscription management (Trial, Basic, Pro)
- Crypto payments via NOWPayments
- Model management with limits
- Fans tracking and history

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Required variables:
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret key for JWT tokens
- `NOWPAYMENTS_API_KEY` - Your NOWPayments API key
- `NOWPAYMENTS_IPN_SECRET` - Your NOWPayments IPN secret
- `APP_URL` - Your app URL (for callbacks)

### 3. Initialize database

```bash
npm run db:init
```

### 4. Run the server

Development:
```bash
npm run dev
```

Production:
```bash
npm start
```

## API Endpoints

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login user |
| GET | `/api/auth/verify` | Verify token & get user info |
| POST | `/api/auth/change-password` | Change password |

### Subscription

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/subscription/status` | Get subscription status |
| GET | `/api/subscription/plans` | Get available plans |
| GET | `/api/subscription/crypto-currencies` | Get available cryptocurrencies |
| GET | `/api/subscription/estimate/:plan/:currency` | Get price estimate in crypto |
| POST | `/api/subscription/create-payment` | Create payment |
| GET | `/api/subscription/payment-status/:id` | Check payment status |

### Models

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/models` | Get user's models |
| POST | `/api/models/add` | Add a model |
| DELETE | `/api/models/:username` | Remove a model |
| GET | `/api/models/check/:username` | Check if model is added |

### Fans

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/fans/report` | Report fans count |
| GET | `/api/fans/:username` | Get last known fans |
| GET | `/api/fans/:username/history` | Get fans history |
| POST | `/api/fans/batch` | Batch get fans for multiple models |

### Webhooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webhooks/nowpayments` | NOWPayments IPN webhook |

## Plans

| Plan | Price | Model Limit |
|------|-------|-------------|
| Trial | Free | Unlimited (7 days) |
| Basic | $30/mo | 10 models |
| Pro | $50/mo | 50 models |

## Deployment on Railway

1. Create new project on Railway
2. Add PostgreSQL database
3. Deploy from GitHub
4. Set environment variables
5. Run `npm run db:init` via Railway CLI or console

## NOWPayments Setup

1. Create account at https://nowpayments.io
2. Get API key from dashboard
3. Set IPN callback URL to `https://your-app.railway.app/api/webhooks/nowpayments`
4. Copy IPN secret for webhook verification
