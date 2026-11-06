-- T-7.11/T-7.12: a PDF uploaded in a chat is searched only in that chat; each chat chooses whether to use the library.
ALTER TABLE papers ADD COLUMN chat_id TEXT; -- uploads: the chat it was added in; NULL = curated or personal library
CREATE INDEX idx_papers_chat ON papers (chat_id) WHERE chat_id IS NOT NULL;
ALTER TABLE chats ADD COLUMN use_library INTEGER CHECK (use_library IN (0, 1)); -- NULL = default: on unless the chat has PDFs
