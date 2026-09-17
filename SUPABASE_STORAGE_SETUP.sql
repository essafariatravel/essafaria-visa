-- Run once in Supabase SQL Editor.
-- Creates a private bucket for ESSAFARIA applicant/admin media.
-- The application accesses this bucket server-side with SUPABASE_SERVICE_ROLE_KEY.
insert into storage.buckets (id, name, public)
values ('essafaria-media', 'essafaria-media', false)
on conflict (id) do nothing;
