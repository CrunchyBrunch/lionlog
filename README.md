# LionLog

LionLog is a mobile-first dining hall meal builder. The `v0.1.0-alpha.1` foundation lets a user choose a sample dining hall, meal period, service date, and one or more venues, then inspect the matching foods and their source serving units.

This milestone uses illustrative static data only. It does not contain a meal optimizer, live Penn State data, accounts, persistence, or backend infrastructure.

## Requirements

- Node.js 22.13 or newer

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Verify

```bash
npm test
npm run lint
```

The project is a React, Vite, and TypeScript site built with vinext for static-first Sites deployment. Domain contracts live in `domain/`, application coordination in `application/`, and the replaceable sample provider in `infrastructure/`.
