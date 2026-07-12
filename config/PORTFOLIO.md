# Ryan Brown — Portfolio & Technical Projects

**Denver, CO** | 303-549-1697 | rmbrown119@gmail.com
linkedin.com/in/ryan-brown-a759b072 | github.com/doctorfixes

---

## Professional Summary

Operations leader with 8+ years driving P&L performance across full-service and select-service hotels (Marriott, Hyatt, Renaissance, Aloft, Stonebridge). Combines hands-on operational leadership with AI engineering — building deployed tools for real estate analysis, agent automation, and operational intelligence.

## Shipped Projects

### DealScore — Real Estate Deal Analysis Platform
*Live: Netlify + Railway + Supabase*

AI-powered tool that scores any real estate deal in 30 seconds — ROI, ARV, comps, and flood risk on one page. Built as a full-stack application with React/Vite frontend, FastAPI backend, Supabase for data/auth, and deployed on Netlify + Railway.

**Stack:** React, TypeScript, Vite, Tailwind CSS, FastAPI, Supabase, PostgreSQL

### Agent-N9er — AI Agent Framework & Freelancer Automation
*Live: Netlify (Next.js dashboard) + Railway (bid service)*

Lightweight ReAct-style AI agent framework built on OpenAI API. Features `@tool` decorator for tool binding, conversation memory, and Rich CLI. Powers a fully automated freelancer bidding pipeline: scans Upwork/Freelancer, evaluates job fit, generates proposals, and submits bids autonomously.

**Stack:** Python, OpenAI API, Next.js, FastAPI, Railway, Docker

**Key milestones:**
- ReAct-style think/act loop with tool calling
- Automated job evaluation + proposal generation
- Freelancer.com OAuth integration
- Bid service with configurable spend controls

### Verixio — Deterministic Parcel Rating Engine
*Live: Railway (FastAPI) + PostgreSQL/PostGIS*

Parcel-intelligence platform that ingests Denver open data (permits, crime, 311 complaints, environmental) and scores every parcel across three composite dimensions (NTS, TCS, VGD). Includes a Change Radar for detecting meaningful score shifts and alerting.

**Stack:** Python, FastAPI, PostgreSQL/PostGIS, Alembic, pytest (88%+ coverage), Railway CI/CD

**Key milestones:**
- Automated daily ingestion pipeline (ArcGIS → parsed data)
- ML-driven calibrator that learns weights from outcomes
- Change Radar with email/webhook alerts
- 120+ seeded parcels, 88%+ test coverage

### ZoneCheck — Property Risk Profiling API
*Live: Supabase Edge Functions + Zuplo API gateway*

Serverless API that converts any US address into a unified property risk profile — combining FEMA flood zone determination with neighborhood-level risk scoring (NTS, TCS, VGD). Designed as composable Edge Functions with Stripe billing integration.

**Stack:** TypeScript, Supabase Edge Functions, FEMA NFHL API, Census geocoder, Zuplo

### Business OS — AI Operations Platform
*Self-hosted Docker stack*

Self-hosted AI operations platform that orchestrates multi-agent workflows, monitors GitHub repos, and provides a unified ops dashboard. Features M4 agent architecture with CoderAgent that writes files/commits/PRs, M5 feedback loop (revise/approve/dismiss), and GitHub webhook integration.

**Stack:** Python, FastAPI, Docker Compose, Supabase, GitHub API, n8n

**Key milestones:**
- 533 tests / 92% code coverage
- Multi-agent orchestration with feedback loop
- 7-project growth flywheel system
- Production deployment with monitoring

## Core Competencies

| Domain | Skills |
|--------|--------|
| **Operations Management** | Full P&L ownership, budgeting/forecasting, revenue strategy, vendor negotiation, process optimization |
| **Hotel Operations** | Openings (3 properties, 600+ rooms), guest satisfaction (top 11 JW ITR), team development (manager + 45 associates), service score transformation (+10 GSS points) |
| **Revenue & Analytics** | RevPAR improvement ($132→$137), 67% group revenue growth, 112.1 ADR index, STR/CoStar, Amadeus Demand360 |
| **Software Engineering** | Full-stack development (React, FastAPI, Python, TypeScript), Docker, CI/CD, API design, Edge Functions |
| **AI & Automation** | AI agent frameworks, ReAct patterns, LLM integration, scoring systems, automated pipelines |
| **Infrastructure** | Docker, Railway, Netlify, Supabase, PostgreSQL/PostGIS, n8n, VPS deployment |

## Education

**Bachelor of Science: Management** — Colorado State University, Fort Collins, CO