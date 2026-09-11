-- Rebuild projections persisted before PostgreSQL publication flags became numeric.
DO $$
BEGIN
  IF to_regclass(format('%I.runtime_values', current_schema())) IS NOT NULL THEN
    DELETE FROM runtime_values
    WHERE actor LIKE 'season:%'
      AND (key = 'status-read-model:v2:manifest'
        OR key LIKE 'status-read-model:v2:chunk:%');
  END IF;
END $$;
