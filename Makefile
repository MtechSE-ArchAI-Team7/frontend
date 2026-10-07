.PHONY: sync typecheck test build check deploy

UV_CACHE_DIR ?= /tmp/aios-frontend-uv-cache
export UV_CACHE_DIR

sync:
	uv sync --frozen
	npm ci

typecheck:
	npm run typecheck

test:
	npm test
	uv run pytest agent3/backend agent4/backend

build:
	npm run build
	BUILD_OUT_DIR=agent4/backend/site npm run build

check: sync typecheck test build

deploy: check
	bash scripts/deploy_agent3_ui.sh
	bash scripts/deploy_agent4_ui.sh
