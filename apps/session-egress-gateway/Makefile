.PHONY: build test check vet docker
build:
	bash build.sh build
test:
	bash build.sh test
	node --test build.test.mjs
vet:
	bash build.sh vet
check: test vet build
docker:
	docker build -t session-egress-gateway .
