"""Migration 20261027090000_pinecone_vector_store, applied on top of realistic legacy data in a THROWAWAY database (created and dropped
here; the name must end in _mig_test). Proves: every existing value survives, older application code still works, nothing is dropped."""

from __future__ import annotations

import uuid

import psycopg
import pytest

from tests.conftest import BACKEND_MIGRATIONS, TEST_DB_URL

MIG = "20261027090000_pinecone_vector_store"


def _admin_url() -> str:
    return TEST_DB_URL.rsplit("/", 1)[0] + "/postgres"


def _url(name: str) -> str:
    return TEST_DB_URL.rsplit("/", 1)[0] + "/" + name


def vec(n: int, x: float = 0.1) -> str:
    return "[" + ",".join([str(x)] * n) + "]"


@pytest.fixture
def mig_db():
    name = f"studyforge_{uuid.uuid4().hex[:8]}_rag_mig_test"
    assert name.endswith("_mig_test") and name != TEST_DB_URL.rsplit("/", 1)[1]
    with psycopg.connect(_admin_url(), autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        yield name
    finally:
        with psycopg.connect(_admin_url(), autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def apply(conn, upto_excluding: str | None = None, only: str | None = None) -> None:
    for d in sorted(p for p in BACKEND_MIGRATIONS.iterdir() if (p / "migration.sql").exists()):
        if only and d.name != only:
            continue
        if upto_excluding and d.name >= upto_excluding:
            break
        conn.execute((d / "migration.sql").read_text())


def seed_legacy(conn) -> None:
    conn.execute("INSERT INTO \"User\" (\"id\",\"name\",\"email\",\"updatedAt\") VALUES ('u1','u','u@x.test',now())")
    conn.execute(
        'INSERT INTO "Document" ("id","ownerId","name","extension","mimeType","sizeBytes","sha256","storageKey","status","processingVersion","embeddingProvider","embeddingModel","embeddingDimension","updatedAt") '
        "VALUES ('d1','u1','n.txt','txt','text/plain',1,'sha','k1','READY',1,'OPENAI','text-embedding-3-small',1536,now())")
    # as the pre-migration pipeline wrote them: vector (+provider/model), dimension GENERATED
    for i, (n, model) in enumerate([(1536, "text-embedding-3-small"), (1536, "text-embedding-3-small"), (768, "small-768")]):
        conn.execute(
            'INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingProvider","embeddingModel","embedding") '
            "VALUES (%s,'d1','u1',%s,1,%s,1,'openai',%s,%s::vector)", (f"c{i}", i, f"text {i}", model, vec(n, 0.1 * (i + 1))))


def test_values_survive_and_the_column_stops_being_generated(mig_db):
    with psycopg.connect(_url(mig_db), autocommit=True) as conn:
        apply(conn, upto_excluding=MIG)
        seed_legacy(conn)
        before = conn.execute('SELECT "id","embeddingDimension","embedding"::text,"content" FROM "DocumentChunk" ORDER BY "id"').fetchall()
        gen_before = conn.execute("SELECT is_generated FROM information_schema.columns WHERE table_name='DocumentChunk' AND column_name='embeddingDimension'").fetchone()[0]
        assert gen_before == "ALWAYS" and [r[1] for r in before] == [1536, 1536, 768]
        apply(conn, only=MIG)
        after = conn.execute('SELECT "id","embeddingDimension","embedding"::text,"content" FROM "DocumentChunk" ORDER BY "id"').fetchall()
        assert after == before  # every dimension, vector and text is byte-for-byte what it was
        cols = {r[0]: (r[1], r[2]) for r in conn.execute(
            "SELECT column_name,is_generated,is_nullable FROM information_schema.columns WHERE table_name='DocumentChunk' AND column_name IN ('embeddingDimension','pineconeIndexedAt','embedding')").fetchall()}
        assert cols["embeddingDimension"] == ("NEVER", "YES") and cols["pineconeIndexedAt"] == ("NEVER", "YES") and cols["embedding"][1] == "YES"
        assert conn.execute('SELECT count(*) FROM "DocumentChunk" WHERE "pineconeIndexedAt" IS NOT NULL').fetchone()[0] == 0  # nothing is claimed to be in Pinecone
        assert conn.execute("SELECT count(*) FROM \"DocumentChunk\"").fetchone()[0] == 3  # nothing dropped


def test_code_from_before_the_migration_keeps_working(mig_db):
    with psycopg.connect(_url(mig_db), autocommit=True) as conn:
        apply(conn)
        seed_legacy_after = conn.execute("INSERT INTO \"User\" (\"id\",\"name\",\"email\",\"updatedAt\") VALUES ('u1','u','u@x.test',now())")
        conn.execute(
            'INSERT INTO "Document" ("id","ownerId","name","extension","mimeType","sizeBytes","sha256","storageKey","status","updatedAt") '
            "VALUES ('d1','u1','n.txt','txt','text/plain',1,'sha','k1','READY',now())")
        old_insert = ('INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount",'
                      '"embeddingProvider","embeddingModel","embedding") VALUES (%s,\'d1\',\'u1\',%s,1,\'t\',1,\'openai\',\'m\',%s::vector)')
        conn.execute(old_insert, ("a", 0, vec(1536)))  # the old pipeline's INSERT: vector only, no dimension
        conn.execute(old_insert, ("b", 1, vec(256)))
        assert conn.execute('SELECT "id","embeddingDimension" FROM "DocumentChunk" ORDER BY "id"').fetchall() == [("a", 1536), ("b", 256)]
        # old identity uniqueness still holds
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute(old_insert, ("c", 0, vec(1536)))


def test_the_dimension_can_never_disagree_with_a_local_vector(mig_db):
    with psycopg.connect(_url(mig_db), autocommit=True) as conn:
        apply(conn)
        conn.execute("INSERT INTO \"User\" (\"id\",\"name\",\"email\",\"updatedAt\") VALUES ('u1','u','u@x.test',now())")
        conn.execute('INSERT INTO "Document" ("id","ownerId","name","extension","mimeType","sizeBytes","sha256","storageKey","status","updatedAt") VALUES (\'d1\',\'u1\',\'n\',\'txt\',\'text/plain\',1,\'s\',\'k\',\'READY\',now())')
        base = ('INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingProvider","embeddingModel","embedding","embeddingDimension") '
                "VALUES (%s,'d1','u1',%s,1,'t',1,'openai','m',%s::vector,%s)")
        conn.execute(base, ("ok", 0, vec(512), 512))
        with pytest.raises(psycopg.errors.RaiseException, match="must equal the length"):
            conn.execute(base, ("lie", 1, vec(512), 1536))  # an explicit, wrong dimension next to a real vector is refused
        conn.execute('UPDATE "DocumentChunk" SET "embeddingDimension" = 99 WHERE "id" = \'ok\'')
        assert conn.execute('SELECT "embeddingDimension" FROM "DocumentChunk" WHERE "id"=\'ok\'').fetchone()[0] == 512  # re-derived, not honoured
        conn.execute('UPDATE "DocumentChunk" SET "embedding" = %s::vector WHERE "id" = \'ok\'', (vec(256),))
        assert conn.execute('SELECT "embeddingDimension" FROM "DocumentChunk" WHERE "id"=\'ok\'').fetchone()[0] == 256


def test_rows_without_a_local_vector_carry_their_own_verified_dimension(mig_db):
    with psycopg.connect(_url(mig_db), autocommit=True) as conn:
        apply(conn)
        conn.execute("INSERT INTO \"User\" (\"id\",\"name\",\"email\",\"updatedAt\") VALUES ('u1','u','u@x.test',now())")
        conn.execute('INSERT INTO "Document" ("id","ownerId","name","extension","mimeType","sizeBytes","sha256","storageKey","status","updatedAt") VALUES (\'d1\',\'u1\',\'n\',\'txt\',\'text/plain\',1,\'s\',\'k\',\'READY\',now())')
        ins = ('INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingProvider","embeddingModel","embedding","embeddingDimension","pineconeIndexedAt") '
               "VALUES (%s,'d1','u1',%s,1,'t',1,'openai','m',NULL,1536,now())")
        conn.execute(ins, ("p0", 0))
        assert conn.execute('SELECT "embedding" IS NULL,"embeddingDimension","pineconeIndexedAt" IS NOT NULL FROM "DocumentChunk"').fetchone() == (True, 1536, True)
        with pytest.raises(psycopg.errors.UniqueViolation):  # the identity (incl. dimension) is still part of the unique key
            conn.execute(ins, ("p1", 0))
        conn.execute(ins, ("p2", 1))


def test_the_owner_trigger_and_cascade_are_unaffected(mig_db):
    with psycopg.connect(_url(mig_db), autocommit=True) as conn:
        apply(conn)
        conn.execute("INSERT INTO \"User\" (\"id\",\"name\",\"email\",\"updatedAt\") VALUES ('u1','u','u@x.test',now()),('u2','v','v@x.test',now())")
        conn.execute('INSERT INTO "Document" ("id","ownerId","name","extension","mimeType","sizeBytes","sha256","storageKey","status","updatedAt") VALUES (\'d1\',\'u1\',\'n\',\'txt\',\'text/plain\',1,\'s\',\'k\',\'READY\',now())')
        with pytest.raises(psycopg.errors.RaiseException, match="ownerId must equal"):
            conn.execute('INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingProvider","embeddingModel","embeddingDimension") VALUES (\'x\',\'d1\',\'u2\',0,1,\'t\',1,\'o\',\'m\',8)')
        conn.execute('INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingProvider","embeddingModel","embeddingDimension") VALUES (\'y\',\'d1\',\'u1\',0,1,\'t\',1,\'o\',\'m\',8)')
        conn.execute('DELETE FROM "Document" WHERE "id"=\'d1\'')
        assert conn.execute('SELECT count(*) FROM "DocumentChunk"').fetchone()[0] == 0  # PostgreSQL still cascades its own rows
