async def test_schema_and_extensions(db):
    async with db.connection() as conn:
        cur = await conn.execute("SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm') ORDER BY 1")
        assert [r[0] for r in await cur.fetchall()] == ["pg_trgm", "vector"]
