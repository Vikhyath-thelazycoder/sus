-- Vector IDs whose D1 rows are gone but whose Vectorize delete may not have finished (SECURITY §12 #16).
-- Written in the same batch that deletes the rows; cleared once Vectorize confirms; the cron retries what is left.
CREATE TABLE vector_tombstones (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
