-- Journal parts the organizer wasn't sure about wait for the user to pick a
-- journal: notebook_id becomes nullable and entries carry a review status,
-- the organizer's confidence, its question and the journals it suggests.
CREATE TABLE notebook_entries_v2 (
    id TEXT PRIMARY KEY NOT NULL,
    notebook_id TEXT, -- NULL while status = 'needs_review'
    meeting_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    key_points TEXT, -- JSON array of strings
    start_time REAL,
    end_time REAL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'filed', -- filed | needs_review
    confidence REAL, -- 0..1, as reported by the organizer
    question TEXT, -- what the organizer asks the user, when unsure
    suggestions TEXT, -- JSON array of {notebook_id?, title, description?}
    FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

INSERT INTO notebook_entries_v2 (id, notebook_id, meeting_id, title, summary, key_points, start_time, end_time, created_at)
SELECT id, notebook_id, meeting_id, title, summary, key_points, start_time, end_time, created_at FROM notebook_entries;

DROP TABLE notebook_entries;
ALTER TABLE notebook_entries_v2 RENAME TO notebook_entries;

CREATE INDEX IF NOT EXISTS idx_notebook_entries_notebook ON notebook_entries(notebook_id);
CREATE INDEX IF NOT EXISTS idx_notebook_entries_meeting ON notebook_entries(meeting_id);
CREATE INDEX IF NOT EXISTS idx_notebook_entries_status ON notebook_entries(status);
