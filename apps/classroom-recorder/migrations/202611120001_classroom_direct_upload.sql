alter table public.classroom_lessons
  add column if not exists "earlyAt" bigint,
  add column if not exists "finalUploadAt" bigint;
