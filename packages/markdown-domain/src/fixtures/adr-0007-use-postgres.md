# ADR 7: Use PostgreSQL for the control plane

* Status: accepted
* Deciders: platform team
* Date: 2026-01-15

## Context and Problem Statement

We need durable storage for installations and review sessions. Candidates
were evaluated against operational cost and portability.

## Decision Drivers

* Managed offerings on every major cloud
* Strong transactional semantics
* Familiar to the team

## Considered Options

1. PostgreSQL
2. SQLite with replication
3. A document store

## Decision Outcome

Chosen option: **PostgreSQL**, because it satisfies every driver.

### Consequences

* Good, because migrations are well understood.
* Bad, because local development needs a running server:

  ```sh
  docker run --rm -p 5432:5432 postgres:17
  ```

<details>
<summary>Benchmark notes</summary>

Throughput was measured with `pgbench` at scale factor 100.

</details>

---

Supersedes [ADR 3](0003-use-sqlite.md).
