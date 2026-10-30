CREATE TABLE public_api_major_usage_dropped_interval (
  process_id      uuid        NOT NULL,
  batch           bigint      NOT NULL,
  environment     text        NOT NULL,
  dropped_from    timestamptz NOT NULL,
  dropped_through timestamptz NOT NULL,
  PRIMARY KEY (process_id, batch),
  CONSTRAINT public_api_major_usage_dropped_interval_process_fk
    FOREIGN KEY (process_id)
    REFERENCES public_api_major_usage_coverage(process_id)
    ON DELETE CASCADE,
  CONSTRAINT public_api_major_usage_dropped_interval_batch_check
    CHECK (batch > 0),
  CONSTRAINT public_api_major_usage_dropped_interval_environment_check
    CHECK (environment IN ('production', 'sandbox')),
  CONSTRAINT public_api_major_usage_dropped_interval_order_check
    CHECK (dropped_through >= dropped_from)
);

CREATE INDEX public_api_major_usage_dropped_interval_window_idx
  ON public_api_major_usage_dropped_interval (dropped_through);
