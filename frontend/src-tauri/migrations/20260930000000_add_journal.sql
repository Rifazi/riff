-- Journal: meeting notes organized into topic notebooks.
-- A notebook is a topic that accumulates entries across meetings. An entry is
-- one meeting's discussion of that topic, pointing back at the recording time
-- range it came from.
CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    color TEXT NOT NULL,
    -- 1 when the organizer created it; empty auto-created notebooks are pruned.
    auto_created INTEGER NOT NULL DEFAULT 1,
    summary_markdown TEXT,
    summary_updated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notebook_entries (
    id TEXT PRIMARY KEY NOT NULL,
    notebook_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    key_points TEXT, -- JSON array of strings
    start_time REAL, -- seconds from the start of the recording
    end_time REAL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notebook_entries_notebook ON notebook_entries(notebook_id);
CREATE INDEX IF NOT EXISTS idx_notebook_entries_meeting ON notebook_entries(meeting_id);

-- Per-meeting organizer status: pending | processing | completed | failed | skipped
CREATE TABLE IF NOT EXISTS journal_meeting_status (
    meeting_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
