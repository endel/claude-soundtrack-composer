-- Saves a track template holding one plug-in, then quits REAPER: added by name with its default state, or the first
-- track of a project. The plug-in gets `wait` seconds first, so whatever it loads on its own (a drum kit) is in the
-- state it saves.
--
-- The job returns { name, add = { names to try in turn }, wait, file, out, empty }, or { project, wait, file, out, empty }.

local here = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local J = dofile(here .. "json.lua")
local job = dofile(os.getenv("COMPOSER_JOB"))

local tr, fx
if job.project then
  reaper.Main_openProject("noprompt:" .. job.project)
  tr = reaper.GetTrack(0, 0)
  fx = tr and reaper.TrackFX_GetCount(tr) > 0 and 0 or -1
  job.add = { "the first track's plug-in in " .. job.project }
else
  reaper.Main_openProject("noprompt:" .. job.empty)
  reaper.InsertTrackAtIndex(0, false)
  tr = reaper.GetTrack(0, 0)
  reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", job.name, true)
  fx = -1
  for _, name in ipairs(job.add) do
    fx = reaper.TrackFX_AddByName(tr, name, false, -1)
    if fx >= 0 then break end
  end
end

if fx < 0 then
  J.finish(job, { ok = false, error = "none of " .. table.concat(job.add, ", ") .. " could be added" })
else
  local t0 = reaper.time_precise()
  local function save()
    if reaper.time_precise() - t0 < (job.wait or 0) then return reaper.defer(save) end
    local _, chunk = reaper.GetTrackStateChunk(tr, "", false)
    J.write_file(job.file, chunk)
    local _, full = reaper.TrackFX_GetFXName(tr, fx, "")
    J.finish(job, { ok = true, fx = full, bytes = #chunk })
  end
  save()
end
