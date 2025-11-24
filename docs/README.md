# Documentation Guide

## Overview

This directory contains all project documentation for Tap Story.

## Documentation Structure

### Current State Documentation

These documents describe the **current** implementation and architecture:

- **[architecture.md](./architecture.md)** - System architecture, components, and data flows
- **[backend.md](./backend.md)** - Backend API implementation and structure
- **[mobile.md](./mobile.md)** - Mobile app architecture and features
- **[infrastructure.md](./infrastructure.md)** - Deployment and hosting setup
- **[services.md](./services.md)** - External service integrations

**Important:** These docs should reflect what is actually built, not future plans. When features are planned but not yet implemented, they should be clearly marked with notes like:

> **Note:** This feature is not yet implemented.

or

> (Not yet configured)

### Planning Documentation

The `plans/` subdirectory contains:
- Implementation plans
- Architecture decisions
- Feature specifications
- Development milestones

These documents are forward-looking and describe what will be built.

**Current plans:**
- [2024-11-23-project-structure-plan.md](./plans/2024-11-23-project-structure-plan.md) - Initial project structure
- [PROOF_OF_CONCEPT.md](./plans/PROOF_OF_CONCEPT.md) - POC implementation plan
- [INITIAL_OVERALL_PLAN.md](./plans/INITIAL_OVERALL_PLAN.md) - Overall project vision

### Archival Documentation

(Not yet created)

As features are completed or deprecated, milestone documentation can be moved to:
- `completed-milestones/` - Finished feature implementations
- `archived/` - Deprecated or abandoned approaches

## Documentation Guidelines

### When to Update Docs

Update current state docs when:
- Adding new features or components
- Changing architecture or structure
- Modifying deployment processes
- Integrating new services
- Making breaking changes

### What to Document

For each major component or feature, document:
- **What it does** - Purpose and functionality
- **How it works** - Technical implementation
- **How to use it** - Development and deployment
- **Configuration** - Environment variables and settings
- **Dependencies** - External services and libraries

### Documentation Style

- Keep docs factual and accurate
- Use code examples where helpful
- Link between related docs
- Mark unimplemented features clearly
- Update docs alongside code changes

## Finding Information

**New to the project?**
- Start with [architecture.md](./architecture.md) for system overview
- Then read the main [README.md](../README.md) for setup instructions

**Working on backend?**
- See [backend.md](./backend.md) for API structure
- Check [services.md](./services.md) for external integrations

**Building mobile features?**
- See [mobile.md](./mobile.md) for app architecture
- Check [architecture.md](./architecture.md) for API integration

**Deploying?**
- See [infrastructure.md](./infrastructure.md) for deployment workflows
- Check [services.md](./services.md) for service configuration
