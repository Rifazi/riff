-- Notes the user types into a journal belong to no meeting: meeting_id becomes nullable.
CREATE TABLE notebook_entries_v3 (
    id TEXT PRIMARY KEY NOT NULL,
    notebook_id TEXT,
    meeting_id TEXT, -- NULL for a note typed into the journal
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    key_points TEXT,
    start_time REAL,
    end_time REAL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'filed',
    confidence REAL,
    question TEXT,
    suggestions TEXT,
    FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

INSERT INTO notebook_entries_v3 (id, notebook_id, meeting_id, title, summary, key_points, start_time, end_time,
                                 created_at, status, confidence, question, suggestions)
SELECT id, notebook_id, meeting_id, title, summary, key_points, start_time, end_time,
       created_at, status, confidence, question, suggestions FROM notebook_entries;

DROP TABLE notebook_entries;
ALTER TABLE notebook_entries_v3 RENAME TO notebook_entries;

CREATE INDEX IF NOT EXISTS idx_notebook_entries_notebook ON notebook_entries(notebook_id);
CREATE INDEX IF NOT EXISTS idx_notebook_entries_meeting ON notebook_entries(meeting_id);
CREATE INDEX IF NOT EXISTS idx_notebook_entries_status ON notebook_entries(status);
