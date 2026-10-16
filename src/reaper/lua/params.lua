-- Lists every parameter of every plug-in in a project, and of any added by name, then quits REAPER.
--
-- The job (COMPOSER_JOB, src/reaper/reaper.ts's runLua) returns { project, add, steps, out, empty }. `add` is a list
-- of plug-ins, each a list of names to try in turn ("VST3:Kontakt 8", "AU:Kontakt 8"). A parameter comes back with
-- its index, name, normalized value, the text the plug-in shows for it, and that text at `steps` + 1 even points.

local here = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local J = dofile(here .. "json.lua")

local function dump(tr, fx, steps)
  local _, name = reaper.TrackFX_GetFXName(tr, fx, "")
  local params = {}
  for p = 0, reaper.TrackFX_GetNumParams(tr, fx) - 1 do
    local _, pn = reaper.TrackFX_GetParamName(tr, fx, p, "")
    local _, now = reaper.TrackFX_GetFormattedParamValue(tr, fx, p, "")
    local shown = {}
    for k = 0, steps do
      local _, s = reaper.TrackFX_FormatParamValueNormalized(tr, fx, p, k / steps, "")
      shown[#shown + 1] = s
    end
    params[#params + 1] = { index = p, name = pn, value = reaper.TrackFX_GetParamNormalized(tr, fx, p), now = now, shown = shown }
  end
  return { name = name, params = params }
end

local job = dofile(os.getenv("COMPOSER_JOB"))

local ok, err = pcall(function()
  reaper.Main_openProject("noprompt:" .. (job.project or job.empty))
  local out = {}
  for _, names in ipairs(job.add or {}) do
    local n = reaper.CountTracks(0)
    reaper.InsertTrackAtIndex(n, false)
    local tr = reaper.GetTrack(0, n)
    local added = false
    for _, name in ipairs(names) do
      if reaper.TrackFX_AddByName(tr, name, false, -1) >= 0 then
        reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", name, true)
        added = true
        break
      end
    end
    if not added then out[#out + 1] = { tried = names, missing = true } end
  end
  for t = 0, reaper.CountTracks(0) - 1 do
    local tr = reaper.GetTrack(0, t)
    local _, tname = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
    for f = 0, reaper.TrackFX_GetCount(tr) - 1 do
      local d = dump(tr, f, job.steps or 10)
      d.track = tname
      out[#out + 1] = d
    end
  end
  J.finish(job, { ok = true, plugins = out })
end)
if not ok then J.finish(job, { ok = false, error = tostring(err) }) end
