# Stock Portfolio Tracker Web

A modern web-based stock portfolio tracker built with React, FastAPI, and PostgreSQL. Track your investments, dividends, and market performance in real-time.

## Features

- **Portfolio Dashboard**: Overview of total value, cost, gain/loss, and return percentage
- **Daily Change**: See daily portfolio change in SEK
- **Portfolio Value Chart**: Track portfolio value over time (90 days)
- **Holdings Management**: Add, edit, and delete stock positions with exchange support
- **Performance Page**: Detailed performance analysis with sorting, best/worst performers, and CSV export
- **Dividend Tracking**: View current year dividends and historical dividend history by year/month
- **Manual Dividends**: Add, edit, and delete manual dividend entries
- **Suppress Dividends**: Hide unwanted broker dividends and restore them later
- **Sector & Portfolio Distribution**: Interactive pie charts showing allocation
- **Market Data**: Real-time market indices (OMX, S&P 500, NASDAQ, etc.)
- **Sparkline Charts**: Mini charts showing index trends
- **Swedish Indices in Header**: OMX30 and OMXPI displayed in navigation
- **Market Hours**: View market open/close times in your local timezone
- **Multi-Exchange Support**: 14 stock exchanges with automatic currency detection
- **Stock Detail View**: Comprehensive stock information with analyst data

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Recharts
- **Backend**: Python 3.11, FastAPI, SQLAlchemy
- **Database**: PostgreSQL 15
- **Containerization**: Docker, Docker Compose

## Prerequisites

- Docker and Docker Compose
- Git

## Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/stock-portfolio-tracker-web.git
   cd stock-portfolio-tracker-web
   ```

2. **Start the application**
   ```bash
   docker compose up -d
   ```

3. **Access the application**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:8000
   - API Documentation: http://localhost:8000/docs

## Usage

### Adding Stocks

1. Navigate to the **Stocks** page
2. Click **Add Stock**
3. Select the exchange (Sweden is default)
4. Enter the ticker symbol (without exchange suffix - it's added automatically)
5. Enter quantity and optional purchase price
6. Click **Add**

### Managing Dividends

1. Go to a stock's detail page by clicking on its ticker
2. Navigate to the **Dividends** tab
3. Click **Add Dividend** to manually add a dividend entry
4. Edit or delete existing manual dividends using the action buttons

### Refreshing Prices

- **Single stock**: Click **Refresh** on the stock's row or detail page
- **All stocks**: Click **Refresh All** on the Stocks page or **Refresh Prices** on Dashboard

## API Endpoints

### Stocks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stocks` | List all stocks |
| GET | `/api/stocks/{ticker}` | Get stock details |
| POST | `/api/stocks` | Add a new stock |
| PATCH | `/api/stocks/{ticker}` | Update stock |
| DELETE | `/api/stocks/{ticker}` | Delete stock |
| POST | `/api/stocks/{ticker}/refresh` | Refresh stock price |
| GET | `/api/stocks/{ticker}/dividends` | Get dividend history |
| GET | `/api/stocks/{ticker}/upcoming-dividends` | Get upcoming dividends |
| GET | `/api/stocks/{ticker}/analyst` | Get analyst data |
| POST | `/api/stocks/{ticker}/manual-dividends` | Add manual dividend |
| PUT | `/api/stocks/{ticker}/manual-dividends/{id}` | Update manual dividend |
| DELETE | `/api/stocks/{ticker}/manual-dividends/{id}` | Delete manual dividend |

### Portfolio

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/portfolio/summary` | Get portfolio summary |
| GET | `/api/portfolio/distribution` | Get portfolio distribution |
| POST | `/api/portfolio/refresh-all` | Refresh all stock prices |

### Market

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/market/indices` | Get market indices |
| GET | `/api/market/exchange-rates` | Get exchange rates |
| GET | `/api/market/hours` | Get market hours |

## Supported Exchanges

| Code | Exchange | Currency |
|------|----------|----------|
| ST | Sweden (Stockholm) | SEK |
| US | USA (NASDAQ/NYSE) | USD |
| L | UK (London) | GBP |
| DE | Germany (Xetra) | EUR |
| PA | France (Paris) | EUR |
| MI | Italy (Milan) | EUR |
| AM | Netherlands (Amsterdam) | EUR |
| BR | Belgium (Brussels) | EUR |
| TO | Canada (Toronto) | CAD |
| AX | Australia | AUD |
| HK | Hong Kong | HKD |
| T | Japan (Tokyo) | JPY |
| KS | South Korea | KRW |
| SW | Switzerland | CHF |

## Configuration

### Environment Variables

The application uses these environment variables (set in docker-compose.yml):

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://portfolio:portfolio@postgres:5432/portfolio` | PostgreSQL connection string |

### Timezone Settings

- Default timezone: Europe/Stockholm
- Change in Settings page to view market hours in your local time

## Development

### Running in Development Mode

```bash
# Start services
docker compose up -d

# View logs
docker compose logs -f

# Rebuild after changes
docker compose up -d --build
```

### Database Migrations

When adding new columns to the database:

```bash
docker exec stock-portfolio-tracker-web-postgres-1 psql -U portfolio -d portfolio -c "ALTER TABLE stocks ADD COLUMN IF NOT EXISTS new_column JSONB DEFAULT '[]'::jsonb;"
```

For the `stocks.logo` column migration in this repository, run:

```bash
docker compose exec backend python backend/migrations/20260304_add_stocks_logo_column.py upgrade
```

Run this migration during deployment before starting new backend code that reads/writes `stock.logo`.

For the timezone migration (`backend/migrations/20260305_add_timezone_to_datetime_columns.py`):

- Validate first on a staging copy of production.
- Run during a maintenance/low-traffic window because `ALTER COLUMN TYPE` can acquire strong table locks.
- Prepare rollback by running the same script with `downgrade`.

## Project Structure

```
stock-portfolio-tracker-web/
├── docker-compose.yml
├── README.md
├── .gitignore
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── app/
│       ├── main.py
│       ├── routers/
│       │   ├── stocks.py
│       │   ├── portfolio.py
│       │   └── market.py
│       └── services/
│           ├── stock_service.py
│           ├── exchange_rate_service.py
│           └── market_hours_service.py
└── frontend/
    ├── Dockerfile
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── index.css
        ├── services/
        │   └── api.ts
        └── pages/
            ├── Dashboard.tsx
            ├── Stocks.tsx
            ├── StockDetail.tsx
            ├── Markets.tsx
            └── Settings.tsx
```

## Data Sources

- **Stock Prices**: Yahoo Finance API
- **Exchange Rates**: Multiple providers with fallback
- **Market Hours**: Calculated based on exchange timezone

## Limitations

- Yahoo Finance API has rate limits; avoid excessive refresh requests
- Analyst data (price targets, ratings) is limited due to API restrictions
- Some Swedish stocks may have limited data coverage

## License

MIT License
