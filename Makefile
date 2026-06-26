SHELL := /bin/bash

VERSION ?= 0.0.0-dev-$(shell date +%Y%m%d%H%M%S)
ARCH := $(shell uname -m | sed 's/x86_64/x64/')
DIST_BIN := packages/opencode/dist/opencode-darwin-$(ARCH)/bin/opencode
INSTALL_BIN_DIR ?= $(HOME)/.local/share/opencode/bin
INSTALL_BIN := $(INSTALL_BIN_DIR)/opencode
LINK_BIN ?= /usr/local/bin/opencode
SUDO ?= sudo

.PHONY: build install update verify uninstall check-macos

build: check-macos
	OPENCODE_VERSION=$(VERSION) bun run --cwd packages/opencode build --single

install: build
	mkdir -p "$(INSTALL_BIN_DIR)"
	cp "$(DIST_BIN)" "$(INSTALL_BIN)"
	chmod +x "$(INSTALL_BIN)"
	$(SUDO) ln -sf "$(INSTALL_BIN)" "$(LINK_BIN)"
	"$(LINK_BIN)" --version

update: build
	mkdir -p "$(INSTALL_BIN_DIR)"
	cp "$(DIST_BIN)" "$(INSTALL_BIN)"
	chmod +x "$(INSTALL_BIN)"
	"$(INSTALL_BIN)" --version

verify:
	"$(LINK_BIN)" --version

uninstall:
	$(SUDO) rm -f "$(LINK_BIN)"
	rm -rf "$(INSTALL_BIN_DIR)"

check-macos:
	test "$$(uname -s)" = "Darwin"
