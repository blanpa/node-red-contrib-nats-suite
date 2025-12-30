# Node-RED nats-suite Contrib Package Makefile

.PHONY: help install test lint format clean dev docker-up docker-down docker-logs docker-restart package publish audit dev-setup ci-test dev-cycle docs-format release-prepare type-check build build-watch

# Default target
help:
	@echo "Available commands:"
	@echo "  install         - Install dependencies"
	@echo "  test            - Run tests"
	@echo "  lint            - Run ESLint"
	@echo "  format          - Format code with Prettier"
	@echo "  clean           - Clean node_modules and coverage"
	@echo "  dev             - Start legacy development environment"
	@echo "  docker-up       - Start Node-RED with Docker"
	@echo "  docker-down     - Stop Node-RED Docker container"
	@echo "  docker-logs     - Show Docker logs"
	@echo "  docker-restart  - Restart Docker container"
	@echo "  package         - Create npm package"
	@echo "  publish         - Publish to npm (dry-run)"
	@echo "  audit           - Run security audit"
	@echo "  dev-setup       - Setup development environment"
	@echo "  ci-test         - Run CI checks"
	@echo "  dev-cycle       - Run development cycle"
	@echo "  docs-format     - Format documentation"
	@echo "  release-prepare - Prepare for release"
	@echo "  type-check      - Run TypeScript type checking"
	@echo "  build           - Build TypeScript"
	@echo "  build-watch     - Build TypeScript in watch mode"

# Install dependencies
install:
	@echo "Installing dependencies..."
	npm install

# Run tests
test:
	@echo "Running tests..."
	npm test

# Run linting
lint:
	@echo "Running ESLint..."
	npm run lint

# Fix linting issues
lint-fix:
	@echo "Fixing ESLint issues..."
	npm run lint:fix

# Format code
format:
	@echo "Formatting code with Prettier..."
	npm run format

# Type checking
type-check:
	@echo "Running TypeScript type checking..."
	npm run type-check

# Build TypeScript
build:
	@echo "Building TypeScript..."
	npm run build

# Build TypeScript in watch mode
# TODO: TODO example
#  My Todo example issue text
# TODO(!urgent): TODO urgent example
#  My Todo urgent example issue text
build-watch:
	@echo "Building TypeScript in watch mode..."
	npm run build:watch

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf node_modules
	rm -rf coverage
	rm -rf .nyc_output
	rm -rf *.tgz
	rm -rf dist

# Development environment (legacy)
dev:
	@echo "Starting legacy development environment..."
	mkdir -p .node-red
	docker run -it --rm \
		-p 1880:1880 \
		-v $(PWD)/node_modules:/data/node_modules \
		--user $(shell id -u):$(shell id -g) \
		--name node-red-nats-suite \
		-e NODE_RED_ENABLE_SAFE_MODE=false \
		-e NODE_RED_ENABLE_PROJECTS=false \
		nodered/node-red:latest

# Docker commands
docker-up:
	@echo "Starting Node-RED with Docker Compose..."
	docker compose up -d

docker-dev:
	@echo "Starting Node-RED in development mode with Docker Compose..."
	docker compose up

docker-down:
	@echo "Stopping Node-RED Docker container..."
	docker compose down

docker-logs:
	@echo "Showing Docker logs..."
	docker compose logs -f

docker-restart:
	@echo "Restarting Docker container..."
	docker compose restart

# Package management
package:
	@echo "Creating npm package..."
	npm pack

publish:
	@echo "Publishing to npm (dry-run)..."
	npm publish --dry-run

# Security audit
audit:
	@echo "Running security audit..."
	npm audit

audit-fix:
	@echo "Fixing security vulnerabilities..."
	npm audit fix

# Development workflow
dev-setup: install docker-dev
	@echo "Development environment ready!"
	@echo "Node-RED available at: http://localhost:1880"

# CI/CD helpers
ci-test: install test lint audit
	@echo "CI checks completed successfully!"

# Quick development cycle
dev-cycle: format lint-fix test
	@echo "Development cycle completed!"

# Documentation
docs-format:
	@echo "Formatting documentation..."
	prettier --write README.md CHANGELOG.md docs/*.md

# Release preparation
release-prepare: clean install test lint audit package
	@echo "Release preparation completed!"
	@echo "Package created: $(shell ls *.tgz 2>/dev/null | head -1)"
