-- ADR-0121: the Organization name rule also refuses the invisible characters
-- that let one name pass for another, an untrimmed value, and a length outside
-- 1-100. Postgres holds every write path to the same rule the domain applies.
-- Added NOT VALID so existing rows are not scanned on install; 0048 validates it.

ALTER TABLE organizations
  ADD CONSTRAINT organizations_name_display_text_check
  CHECK (
    name = btrim(
      name,
      chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) ||
      chr(160) || chr(5760) ||
      chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) ||
      chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) ||
      chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) ||
      chr(12288) || chr(65279)
    )
    AND char_length(name) BETWEEN 1 AND 100
    AND name !~ (
      '[' ||
      chr(1) || '-' || chr(31) ||
      chr(127) || '-' || chr(159) ||
      chr(173) ||
      chr(1564) ||
      chr(8203) ||
      chr(8206) || '-' || chr(8207) ||
      chr(8232) || '-' || chr(8238) ||
      chr(8288) || '-' || chr(8292) ||
      chr(8294) || '-' || chr(8297) ||
      chr(65279) ||
      ']'
    )
  ) NOT VALID;
