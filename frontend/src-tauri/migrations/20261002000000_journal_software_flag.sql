-- Whether a journal is about building or changing software (an app, site or
-- integration). NULL until the journal's overview is first compiled. Drives the
-- journal's "Create requirements" button.
ALTER TABLE notebooks ADD COLUMN is_software INTEGER;
