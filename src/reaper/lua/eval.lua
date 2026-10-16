-- Runs `job.code` (a Lua chunk that sees `job` and REAPER's API) and answers the table it returns, then quits REAPER.
-- For probing REAPER itself: what it writes for something, what it reads back.

local here = debug.getinfo(1, "S").source:match("^@(.*/)") or "./"
local J = dofile(here .. "json.lua")
local job = dofile(os.getenv("COMPOSER_JOB"))

local ok, res = pcall(function()
  reaper.Main_openProject("noprompt:" .. (job.project or job.empty))
  local fn = assert(load(job.code, "job", "t", setmetatable({ job = job }, { __index = _G })))
  return fn() or {}
end)
if ok then
  res.ok = true
  J.finish(job, res)
else
  J.finish(job, { ok = false, error = tostring(res) })
end
