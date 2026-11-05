-- Thumbs up/down on assistant answers (T-5.3): 1 = helpful, -1 = not helpful, NULL = none.
ALTER TABLE messages ADD COLUMN feedback INTEGER CHECK (feedback IN (-1, 1));
