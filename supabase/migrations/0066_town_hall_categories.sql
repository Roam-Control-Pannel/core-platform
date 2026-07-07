-- 0066_town_hall_categories.sql — topic categories for the Town Hall board redesign.
--
-- One nullable text column: the composer's optional category picker writes it; the board's
-- filter chips (All · Food & Drink · Things to do · Recommendations · Events · Neighbourhood)
-- filter on it. The vocabulary is app-enforced (townHall router categorySchema) — existing
-- topics stay NULL and simply show without a chip, under "All".

alter table public.town_hall_topics
  add column if not exists category text;

create index if not exists idx_town_hall_topics_category
  on public.town_hall_topics (locality, category);
