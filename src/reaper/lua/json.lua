-- JSON out, and the end of a one-shot job: its answer written, REAPER told to quit.

local M = {}

local function esc(s)
  return (s:gsub('[%c"\\]', function(c)
    if c == '"' then return '\\"' end
    if c == "\\" then return "\\\\" end
    if c == "\n" then return "\\n" end
    if c == "\t" then return "\\t" end
    return string.format("\\u%04x", c:byte())
  end))
end

local function is_array(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" then return false end
    n = n + 1
  end
  return n == #t
end

function M.json(v)
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "boolean" then return v and "true" or "false" end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    if math.type(v) == "integer" then return tostring(v) end
    return string.format("%.10g", v)
  end
  if t == "string" then return '"' .. esc(v) .. '"' end
  if is_array(v) then
    local out = {}
    for i = 1, #v do out[i] = M.json(v[i]) end
    return "[" .. table.concat(out, ",") .. "]"
  end
  local keys = {}
  for k in pairs(v) do keys[#keys + 1] = tostring(k) end
  table.sort(keys)
  local out = {}
  for _, k in ipairs(keys) do out[#out + 1] = '"' .. esc(k) .. '":' .. M.json(v[k]) end
  return "{" .. table.concat(out, ",") .. "}"
end

function M.write_file(path, s)
  local f = assert(io.open(path, "wb"))
  f:write(s)
  f:close()
end

-- Writes the answer, leaves the project unsaved and quits.
function M.finish(job, res)
  M.write_file(job.out, M.json(res))
  reaper.Main_openProject("noprompt:" .. job.empty)
  reaper.defer(function() reaper.Main_OnCommand(40004, 0) end) -- File: Quit REAPER
end

return M
