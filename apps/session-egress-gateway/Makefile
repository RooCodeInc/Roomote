.PHONY: build test check vet docker
build:
	bash build.sh build
test:
	bash build.sh test
vet:
	bash build.sh vet
check: test vet build
docker:
	docker build -t session-egress-gateway .
