alter table public.studies
  add column if not exists source_panel_id bigint references public.study_panels(id) on delete set null;

create index if not exists studies_source_panel_id_idx on public.studies(source_panel_id);
