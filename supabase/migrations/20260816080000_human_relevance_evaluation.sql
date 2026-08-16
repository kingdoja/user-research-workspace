-- Human-labeled relevance datasets may only be built from approved, authorized research samples.
alter table public.context_evaluation_sets
  add column if not exists labeling_protocol text not null default 'legacy_v0';

alter table public.context_evaluation_sets
  drop constraint if exists context_evaluation_sets_labeling_protocol_check,
  add constraint context_evaluation_sets_labeling_protocol_check
    check (labeling_protocol in ('legacy_v0', 'human_relevance_v1'));

alter table public.context_evaluation_cases
  add column if not exists labeling_method text not null default 'legacy_unverified',
  add column if not exists labeled_by bigint references public.users(id) on delete set null,
  add column if not exists labeled_at timestamptz,
  add column if not exists label_note text not null default '',
  add column if not exists expected_chunk_snapshot jsonb not null default '[]'::jsonb;

alter table public.context_evaluation_cases
  drop constraint if exists context_evaluation_cases_labeling_method_check,
  add constraint context_evaluation_cases_labeling_method_check
    check (labeling_method in ('legacy_unverified', 'human_annotated')),
  drop constraint if exists context_evaluation_cases_label_note_check,
  add constraint context_evaluation_cases_label_note_check
    check (
      (labeling_method = 'legacy_unverified' and label_note = '' and labeled_at is null)
      or (labeling_method = 'human_annotated' and length(trim(label_note)) >= 2 and labeled_at is not null)
    ),
  drop constraint if exists context_evaluation_cases_expected_chunk_snapshot_check,
  add constraint context_evaluation_cases_expected_chunk_snapshot_check
    check (jsonb_typeof(expected_chunk_snapshot) = 'array');

create index if not exists context_evaluation_cases_human_labels_idx
  on public.context_evaluation_cases(evaluation_set_id, labeled_at desc, id);
