-- Opens a project, gives its plug-ins `wait` seconds to load what they load in the background (a drum kit's samples),
-- renders it with its own settings, then quits REAPER. A command-line render starts at once, before such a plug-in
-- is ready, and it plays silence.
--
-- The job returns { project, wait, out, empty }.

local here = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local J = dofile(here .. "json.lua")
local job = dofile(os.getenv("COMPOSER_JOB"))

reaper.Main_openProject("noprompt:" .. job.project)
local t0 = reaper.time_precise()

local function go()
  if reaper.time_precise() - t0 < (job.wait or 0) then return reaper.defer(go) end
  local r0 = reaper.time_precise()
  reaper.Main_OnCommand(42230, 0) -- File: Render project, using the most recent render settings, auto-close render dialog
  J.finish(job, { ok = true, waited = r0 - t0, rendered = reaper.time_precise() - r0 })
end
go()
