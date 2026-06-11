const _AI_TOOLS = [
  {
    name: 'get_schedule_data',
    description: 'Read current scheduling data from the application. Returns physicians, shifts, IR calls, vacations, holidays, and related data.',
    input_schema: {
      type: 'object',
      properties: {
        collections: {
          type: 'array',
          items: { type: 'string', enum: ['physicians','drShifts','weekendCalls','irShifts','irCalls','vacations','holidays','openShifts','swapRequests','sites','cfg'] },
          description: 'Which data collections to return'
        },
        month: { type: 'string', description: 'Optional YYYY-MM filter to limit shift/call data to a specific month' }
      },
      required: ['collections']
    }
  },
  {
    name: 'assign_dr_shift',
    description: 'Assign a DR shift to a physician on a specific date.',
    input_schema: {
      type: 'object',
      properties: {
        physId:    { type: 'number', description: 'Physician ID' },
        date:      { type: 'string', description: 'Date in YYYY-MM-DD format' },
        shift:     { type: 'string', enum: ['Home','1st','2nd','3rd'], description: 'Shift type' },
        site:      { type: 'string', description: 'Site name, or "At Home / Remote" for home shifts' },
        sub:       { type: 'string', description: 'Subspecialty (optional)' },
        notes:     { type: 'string', description: 'Notes (optional)' }
      },
      required: ['physId','date','shift']
    }
  },
  {
    name: 'remove_shift',
    description: '⚠️ DESTRUCTIVE: Permanently removes a single shift/call by ID. No undo (except via Settings → Backups → Restore). Before calling: verify the type and shiftId match what the admin asked you to remove. If removing multiple shifts, ALWAYS summarize what you intend to delete in your text reply BEFORE executing — give the admin a chance to course-correct. Never batch-remove without confirming aloud first.',
    input_schema: {
      type: 'object',
      properties: {
        type:    { type: 'string', enum: ['drShift','irShift','irCall','weekendCall'], description: 'Type of shift to remove' },
        shiftId: { type: 'number', description: 'The shift ID to remove' }
      },
      required: ['type','shiftId']
    }
  },
  {
    name: 'add_vacation',
    description: 'Add a vacation or time-off block for a physician.',
    input_schema: {
      type: 'object',
      properties: {
        physId: { type: 'number' },
        start:  { type: 'string', description: 'Start date YYYY-MM-DD' },
        end:    { type: 'string', description: 'End date YYYY-MM-DD' },
        type:   { type: 'string', enum: ['Vacation','CME','Sick Leave','Personal','Conference'], description: 'Type of time off' },
        notes:  { type: 'string' }
      },
      required: ['physId','start','end','type']
    }
  },
  {
    name: 'add_ir_call_blackout',
    description: 'Add an IR call blackout period for a physician (dates they cannot take IR call).',
    input_schema: {
      type: 'object',
      properties: {
        physId: { type: 'number' },
        start:  { type: 'string' },
        end:    { type: 'string' },
        reason: { type: 'string' }
      },
      required: ['physId','start','end']
    }
  },
  {
    name: 'fill_dr_home_for_ir',
    description: `Two-tier auto-fill for IR physicians who have no IR shift on a weekday in a given month. Workflow:
  • mode='cross-group' (recommended FIRST step, after the IR shift schedule is built): pulls each unscheduled IR physician into an open IR slot at the OTHER IR group's sites if their site rules allow it. Anyone not placed stays in the pool — the DR shift builder can then pick them for in-person DR shifts.
  • mode='dr-home' (recommended LAST step, after the DR shift schedule is built): mops up anyone STILL unscheduled with a read-from-home DR shift. Skip running this until DR scheduling is done, otherwise IR physicians who would have gotten in-person DR shifts get auto-assigned to Home instead.
  • mode='both' (default, legacy one-shot): runs cross-group then DR Home in a single pass. Only use when you're sure no in-person DR assignments are pending for IR physicians.
Respects vacations, existing shifts, blackouts, site rules, sequence rules, and conference participation.`,
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'Month to fill in YYYY-MM format' },
        mode:  { type: 'string', enum: ['cross-group','dr-home','both'], description: 'Which tier(s) to run. Default "both" matches the old behavior; prefer the two-step workflow ("cross-group" first, then "dr-home" later).' }
      },
      required: ['month']
    }
  },
  {
    name: 'assign_ir_shift',
    description: 'Assign an IR procedure shift to a physician.',
    input_schema: {
      type: 'object',
      properties: {
        physId: { type: 'number' },
        date:   { type: 'string' },
        shift:  { type: 'string', enum: ['1st','Home'] },
        site:   { type: 'string' },
        sub:    { type: 'string' },
        notes:  { type: 'string' }
      },
      required: ['physId','date','shift']
    }
  },
  {
    name: 'create_site',
    description: 'Create a new hospital site. Specify irGroup only if the site belongs to an IR group (North or South). Omit irGroup for general DR-only sites.',
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Site name (must be unique)' },
        irGroup: { type: 'string', enum: ['North','South','Both'], description: 'Optional: IR group assignment' },
        address: { type: 'string', description: 'Optional hospital address for drive-time calc' },
        irAnchorPhysIds: { type: 'array', items: {type:'number'}, description: 'Optional: physician IDs who are IR anchors here (counts toward their IR FTE)' },
        irFillinPhysIds: { type: 'array', items: {type:'number'}, description: 'Optional: physician IDs who are IR fill-ins here (does NOT count toward IR FTE)' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_site',
    description: 'Update an existing site: change IR group, anchors, fill-ins, or street address. Only include fields you want to change. Pass address as an empty string ("") to clear an existing address.',
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Existing site name' },
        irGroup: { type: 'string', enum: ['North','South','Both','none'], description: 'Set "none" to remove IR group' },
        address: { type: 'string', description: 'Street address for drive-time calculation. Pass an empty string to clear it.' },
        irAnchorPhysIds: { type: 'array', items: {type:'number'} },
        irFillinPhysIds: { type: 'array', items: {type:'number'} }
      },
      required: ['name']
    }
  },
  {
    name: 'delete_site',
    description: '⚠️⚠️ EXTREMELY DESTRUCTIVE: Deletes a site AND every DR shift, IR shift, IR call, weekend call, and IR-anchor/fill-in reference for that site. Often deletes hundreds of records across multiple physicians and months — irreversible except via Settings → Backups → Restore. Before calling this tool: (1) name the site explicitly in your text reply, (2) state the approximate record counts (use list_shifts or count_records first), (3) wait for the admin to type "yes delete" or equivalent in their next message. NEVER call this on first request even if the admin sounds confident — the cascade scope is too large to assume intent.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_physician',
    description: 'Update physician properties. Only include fields you want to change.',
    input_schema: {
      type: 'object',
      properties: {
        physId:        { type: 'number' },
        drFte:         { type: 'number', description: 'DR FTE (0.0-1.0)' },
        irFte:         { type: 'number', description: 'IR FTE (0.0-1.0)' },
        irGroup:       { type: 'string', enum: ['North','South','none'] },
        anchorSite:    { type: 'string', description: 'DR anchor site name' },
        irSitePrim:    { type: 'string', description: 'IR primary site name' },
        allowedSites:  { type: 'array', items: {type:'string'}, description: 'All sites this physician can be assigned to' },
        drSubs:        { type: 'array', items: {type:'string'}, description: 'DR subspecialties' },
        irSubs:        { type: 'array', items: {type:'string'}, description: 'IR subspecialties' },
        shiftElig:     { type: 'object', description: 'Shift eligibility flags: {s1,s2,s3,home,wknd} booleans' }
      },
      required: ['physId']
    }
  },
  {
    name: 'add_physician_site_rule',
    description: 'Add or update a site-specific rule for a physician: block them from a site, prefer a site, limit shifts/month/week at a site, or restrict which shift types they can do there.',
    input_schema: {
      type: 'object',
      properties: {
        physId:        { type: 'number' },
        site:          { type: 'string', description: 'Site name the rule applies to' },
        blocked:       { type: 'boolean', description: 'Hard block: cannot be assigned here' },
        preferred:     { type: 'boolean', description: 'Prefer this site for assignments' },
        maxPerMonth:   { type: 'number', description: 'Max shifts per month at this site' },
        maxPerWeek:    { type: 'number', description: 'Max shifts per week at this site' },
        allowedShifts: { type: 'array', items: {type:'string', enum:['1st','2nd','3rd','wknd','ir']}, description: 'Which shift types are allowed at this site' }
      },
      required: ['physId','site']
    }
  },
  {
    name: 'remove_physician_site_rule',
    description: 'Remove a physician\u2019s site rule for a given site.',
    input_schema: {
      type: 'object',
      properties: {
        physId: { type: 'number' },
        site:   { type: 'string' }
      },
      required: ['physId','site']
    }
  },
  {
    name: 'add_physician_day_condition',
    description: 'Add a day-of-week condition for a physician (e.g. "on Tuesdays must be at site CHN for DR shifts"). dow is 0=Sun..6=Sat.',
    input_schema: {
      type: 'object',
      properties: {
        physId:       { type: 'number' },
        dow:          { type: 'number', description: '0=Sun..6=Sat' },
        schedType:    { type: 'string', enum: ['any','dr-shift','ir-call','ir-shift'], description: 'Which schedule this applies to' },
        requiredSite: { type: 'string', description: 'Site physician must be at on this day' },
        notes:        { type: 'string' }
      },
      required: ['physId','dow','requiredSite']
    }
  },
  {
    name: 'set_physician_seq_rules',
    description: 'Set sequence rules for a physician: max consecutive shift days, minimum rest days between shifts, max weekend calls.',
    input_schema: {
      type: 'object',
      properties: {
        physId:      { type: 'number' },
        maxConsec:   { type: 'number' },
        minRest:     { type: 'number' },
        maxWkCalls:  { type: 'number' },
        notes:       { type: 'string' }
      },
      required: ['physId']
    }
  },
  {
    name: 'create_holiday_definition',
    description: 'Create a holiday definition with a name, year, list of blackout dates, and slot counts for each of the three pools (DR, IR North, IR South).',
    input_schema: {
      type: 'object',
      properties: {
        name:          { type: 'string', description: 'Holiday name (e.g. "Thanksgiving 2026")' },
        year:          { type: 'number' },
        dates:         { type: 'array', items: {type:'string'}, description: 'All dates covered (YYYY-MM-DD)' },
        drSlots:       { type: 'number', description: 'Physicians needed from DR pool (0 to skip)' },
        irNorthSlots:  { type: 'number', description: 'Physicians needed from IR North pool' },
        irSouthSlots:  { type: 'number', description: 'Physicians needed from IR South pool' },
        notes:         { type: 'string' }
      },
      required: ['name','year','dates']
    }
  },
  {
    name: 'create_natural_language_rule',
    description: 'Add an "if/then" scheduling rule written in plain English AND a structured representation. These rules are consulted during auto-assign to enforce constraints. Each rule MUST include both a human-readable sentence and a parsed structured form.',
    input_schema: {
      type: 'object',
      properties: {
        sentence: { type: 'string', description: 'Human-readable rule (e.g. "If Dr. Chen is scheduled at CHE, then she must be on 1st shift only")' },
        enabled:  { type: 'boolean', description: 'Default true. Whether rule is active.' },
        when: {
          type: 'object',
          description: 'Trigger conditions (ALL must match). Include only fields that are part of the condition.',
          properties: {
            physId:    { type: 'number', description: 'Rule applies to this specific physician' },
            site:      { type: 'string', description: 'Rule triggers when assignment site is this' },
            shift:     { type: 'string', enum:['1st','2nd','3rd','Home','wknd','ir-call','ir-shift','ir-weekend','holiday'] },
            dow:       { type: 'array', items:{type:'number'}, description: 'Array of day-of-week numbers 0=Sun..6=Sat' },
            sub:       { type: 'string', description: 'Subspecialty' },
            irGroup:   { type: 'string', enum:['North','South'] },
            dateRange: { type: 'object', properties: {start:{type:'string'},end:{type:'string'}} }
          }
        },
        then: {
          type: 'object',
          description: 'Effect: block = reject assignment if when-conditions match.  require = physician MUST be at this site/shift when when-conditions match.  prefer = downrank this assignment.  limit = cap occurrences.',
          properties: {
            action:       { type: 'string', enum:['block','require','prefer','limit'], description: 'What to do when the condition matches' },
            requireSite:  { type: 'string', description: 'For require: the site physician must be at' },
            requireShift: { type: 'string', description: 'For require: the shift type physician must be on' },
            maxPerMonth:  { type: 'number', description: 'For limit: max occurrences per month' },
            maxPerWeek:   { type: 'number', description: 'For limit: max occurrences per week' },
            maxPerYear:   { type: 'number', description: 'For limit: max occurrences per year' }
          },
          required: ['action']
        }
      },
      required: ['sentence','when','then']
    }
  },
  {
    name: 'list_natural_language_rules',
    description: 'List all current natural-language scheduling rules.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'delete_natural_language_rule',
    description: 'Delete a natural-language rule by ID.',
    input_schema: {
      type: 'object',
      properties: { ruleId: { type: 'number' } },
      required: ['ruleId']
    }
  },
  {
    name: 'toggle_natural_language_rule',
    description: 'Enable or disable a natural-language rule without deleting it.',
    input_schema: {
      type: 'object',
      properties: {
        ruleId:  { type: 'number' },
        enabled: { type: 'boolean' }
      },
      required: ['ruleId','enabled']
    }
  },
  {
    name: 'send_notification',
    description: 'Send an email notification to one or more physicians via the app\'s built-in notification system. Use this to confirm actions, inform physicians of schedule changes, announce something, etc. The email is sent to each recipient\'s configured delivery email (falls back to login email) and respects their notification preferences. Common kinds: shiftAssign (new/changed shift), shiftRemove (shift removed), swapRes (swap outcome), holiday (holiday assignment), vacation (vacation logged), broadcast (general announcement). Note: many tools like assign_dr_shift, assign_ir_shift, add_vacation, and remove_shift already send automatic notifications — only call send_notification explicitly when you want to send a custom message or confirm an action that used multiple tools (e.g. a manual swap involving assign + remove).',
    input_schema: {
      type: 'object',
      properties: {
        physIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'List of physician IDs to notify. Each physician must have a linked user account with a delivery email set.'
        },
        subject: {
          type: 'string',
          description: 'Email subject line (under 120 chars). Should be specific and actionable, e.g. "Shift swap confirmed — July 14".'
        },
        body: {
          type: 'string',
          description: 'Email body text. Plain text; line breaks are preserved. Keep it clear and professional. Markdown-style **bold** and *italic* are supported.'
        },
        kind: {
          type: 'string',
          enum: ['shiftAssign','shiftRemove','swapRes','swapReq','holiday','vacation','broadcast'],
          description: 'Notification category — determines which recipient preference gates the email. Default: shiftAssign for assignment confirmations, swapRes for swap-related announcements, broadcast for general messages.'
        }
      },
      required: ['physIds','subject','body']
    }
  },
  {
    name: 'list_physician_rules',
    description: 'Read every per-physician rule (structured + free-text) for one or all physicians. Use this BEFORE proposing rule edits or when an admin asks "what are X\'s rules?". Returns siteRules, dayConditions, seqRules, siteSeqRules, callDayRules, tbRules, AND customRules (the new free-text rules — admins type these in plain English).',
    input_schema: {
      type: 'object',
      properties: {
        physId: { type: 'number', description: 'Physician ID to fetch rules for. Omit to return rules for ALL physicians (use sparingly — output can be large).' }
      }
    }
  },
  {
    name: 'add_physician_custom_rule',
    description: 'Add a free-text custom rule to a physician. Use this when the admin describes a constraint that doesn\'t fit the structured categories (siteRules, dayConditions, etc.). Severity controls behavior at assignment time: info=AI-readable only, warn=show warn-and-confirm dialog, block=hard block unless force-overridden.',
    input_schema: {
      type: 'object',
      properties: {
        physId:   { type: 'number', description: 'Physician ID' },
        text:     { type: 'string', description: 'The rule sentence in plain English. Be specific (mention dates / sites / shift types). Example: "Prefers not to be on call the weekend before her board exam (May 10–11, 2026)".' },
        severity: { type: 'string', enum: ['info','warn','block'], description: 'info = AI-readable only, never blocks. warn = warn-and-confirm dialog at assignment. block = refuse without override. Default: warn.' },
        active:   { type: 'boolean', description: 'Whether the rule is active (defaults to true).' }
      },
      required: ['physId','text']
    }
  },
  {
    name: 'update_physician_custom_rule',
    description: 'Modify an existing custom rule (text, severity, or active state). Get the rule ID from list_physician_rules first.',
    input_schema: {
      type: 'object',
      properties: {
        physId:   { type: 'number' },
        ruleId:   { type: 'number', description: 'The custom rule ID returned by list_physician_rules.' },
        text:     { type: 'string', description: 'New rule text (optional).' },
        severity: { type: 'string', enum: ['info','warn','block'], description: 'New severity (optional).' },
        active:   { type: 'boolean', description: 'Enable/disable (optional).' }
      },
      required: ['physId','ruleId']
    }
  },
  {
    name: 'delete_physician_custom_rule',
    description: 'Permanently delete a custom rule from a physician.',
    input_schema: {
      type: 'object',
      properties: {
        physId: { type: 'number' },
        ruleId: { type: 'number' }
      },
      required: ['physId','ruleId']
    }
  },
  {
    // Quick-action: ranks every eligible physician for a specific date /
    // shift / site combo. Surfaces a one-click "find me coverage" answer
    // without the admin manually walking through 12 physicians' rules.
    name: 'find_coverage',
    description: 'Find physicians eligible to cover a shift on a specific date. Returns a ranked list (best first) with eligibility reason and FTE-utilization context. Useful when an admin needs urgent coverage.',
    input_schema: {
      type: 'object',
      properties: {
        date:   { type: 'string', description: 'Date in YYYY-MM-DD format' },
        shift:  { type: 'string', enum: ['1st','2nd','3rd','Home','call','wknd'], description: 'Shift type or call type to find coverage for' },
        site:   { type: 'string', description: 'Site name (optional — defaults to any)' },
        sub:    { type: 'string', description: 'Sub-specialty filter (optional)' },
        kind:   { type: 'string', enum: ['dr','ir'], description: 'DR or IR side (default: dr)' }
      },
      required: ['date','shift']
    }
  }
];

// ── Tool execution ──────────────────────────────────────────────────────
function _aiExecuteTool(name, input) {
  const adminOk = _isAdminOrSU();

  if(name === 'get_schedule_data'){
    const result = {};
    const month = input.month;
    (input.collections||[]).forEach(k => {
      let data = S[k];
      if(!data){ result[k] = []; return; }
      // Filter by month if provided and collection has date fields
      if(month && Array.isArray(data)){
        const dated = ['drShifts','irShifts','irCalls','weekendCalls'];
        if(dated.includes(k)){
          data = data.filter(x => (x.date||x.satDate||'').startsWith(month));
        }
        if(k==='vacations'){
          data = data.filter(v => v.start <= month+'-31' && v.end >= month+'-01');
        }
      }
      result[k] = data;
    });
    // Add physician name helper
    result._pname = (id) => {
      const p = S.physicians.find(x=>x.id===id);
      return p ? `${p.last}, ${p.first}` : `ID ${id}`;
    };
    return { ok: true, data: result };
  }

  if(name === 'assign_dr_shift'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {physId, date, shift, site, sub, notes, force} = input;
    // Parameter validation: catch malformed inputs BEFORE they hit
    // the data layer. Without this, a date like "Jan 15" or "2026/01/01"
    // would silently fail vacation-match + create a record with an
    // unparseable date string. The AI agent gets a clear error it
    // can quote back and recover from.
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { ok:false, error:'date must be in YYYY-MM-DD format (got: ' + JSON.stringify(date) + ').' };
    if(!['1st','2nd','3rd','Home'].includes(shift)) return { ok:false, error:'shift must be one of: 1st, 2nd, 3rd, Home (got: ' + JSON.stringify(shift) + ').' };
    // rs-v102: schedule-lock parity with the manual path (the AI could
    // previously write into locked months).
    if(typeof isMonthLocked === 'function' && isMonthLocked(date)) return { ok:false, error:`Month ${date.slice(0,7)} is locked (Schedule Lock). Unlock it in Settings before editing.` };
    const p = _physById(physId);
    if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
    const vd = vacDays(physId);
    if(vd.has(date)) return { ok:false, error:`${p.last} is on vacation on ${date}.` };
    const existing = S.drShifts.find(s=>s.physId===physId&&s.date===date);
    if(existing) return { ok:false, error:`${p.last} already has a DR shift on ${date} (shift: ${existing.shift}).` };
    // rs-v102: cross-type collision parity (one-shift-per-day) — the
    // old check only caught same-day DR shifts, missing IR shifts,
    // IR calls, and weekend calls.
    if(!force && typeof _physBookingsOnDate === 'function'){
      const _b = _physBookingsOnDate(physId, date);
      if(_b.length) return { ok:false, error:`${p.last} already has on ${date}: ${_b.map(x=>x.kind).join(', ')}. One shift per day — remove it first, or retry with force:true.` };
    }
    // Home / 2nd / 3rd are read-from-home shifts — always At Home / Remote.
    // Force the site even if the caller passed something else, so the AI
    // can't accidentally create "2nd @ CHN" type records.
    const siteName = _isHomeOnlyShift(shift)
      ? 'At Home / Remote'
      : (site || (p.anchorSite||S.sites[0]?.name||''));
    // Physician-rule check. AI tools can't prompt for confirmation, so rule
    // violations are a hard error unless the caller passes force:true.
    // Returning the violation list lets the AI agent decide whether to
    // propose an alternative or retry with force.
    const _shiftKey = shift==='1st'?'s1':shift==='2nd'?'s2':shift==='3rd'?'s3':shift==='Home'?'home':'';
    const _violations = _gatherManualRuleViolations(p, {
      physId, date, site:siteName, shift, sub, kind:'dr-shift',
      shiftKey:_shiftKey, ym:date.slice(0,7),
    });
    if(_violations.length && !force){
      return { ok:false, error:`Physician rule violations:\n  • ${_violations.join('\n  • ')}\n\nRetry with force:true to override.` };
    }
    S.drShifts.push({
      id: S.nextId++, physId, date,
      shift, site: siteName,
      sub: sub||'', notes: notes||'AI assigned', autoHome: shift==='Home'
    });
    triggerSave();
    if(document.getElementById('drb-tbody')) renderDRBuilder();
    _notify('shiftAssign',{
      physId,
      subject:`New DR shift: ${date} (${shift})`,
      body:`You've been assigned a new DR shift:\n\nDate: ${date}\nShift: ${shift}\nSite: ${siteName}\n${sub?'Subspecialty: '+sub+'\n':''}\nView in RadScheduler → My Schedule.`
    });
    const _overrideNote = _violations.length ? ` (overrode ${_violations.length} rule violation(s))` : '';
    return { ok:true, message:`Assigned ${shift} DR shift to ${p.last} on ${date} at ${siteName}.${_overrideNote}` };
  }

  if(name === 'remove_shift'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {type, shiftId} = input;
    const map = { drShift:'drShifts', irShift:'irShifts', irCall:'irCalls', weekendCall:'weekendCalls' };
    const arr = map[type];
    if(!arr) return { ok:false, error:'Unknown shift type.' };
    const removed = S[arr].find(x=>x.id===shiftId);
    if(!removed) return { ok:false, error:`No ${type} with ID ${shiftId} found.` };
    // Reactive Proxy setter on `S` already calls triggerSave() for top-level array reassignment.
    S[arr] = S[arr].filter(x=>x.id!==shiftId);
    // Notify affected physician
    if(removed.physId!=null){
      const shiftDate = removed.date || removed.satDate || '';
      _notify('shiftRemove',{
        physId: removed.physId,
        subject:`Shift removed: ${shiftDate}`,
        body:`A ${type} on ${shiftDate} has been removed from your schedule.\n\n${removed.site?('Site: '+removed.site+'\n'):''}${removed.shift?('Shift: '+removed.shift+'\n'):''}${removed.notes?('Notes: '+removed.notes+'\n'):''}\nView in RadScheduler → My Schedule.`
      });
    }
    return { ok:true, message:`Removed ${type} ID ${shiftId}.` };
  }

  if(name === 'add_vacation'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {physId, start, end, type, notes} = input;
    const p = S.physicians.find(x=>x.id===physId);
    if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
    if(end < start) return { ok:false, error:'End date must be after start date.' };
    S.vacations.push({id:S.nextId++, physId, start, end, type: type||'Vacation', notes: notes||'AI assigned'});
    triggerSave();
    _notify('vacation',{
      physId,
      subject:`${type||'Vacation'} approved: ${start} to ${end}`,
      body:`An administrator has logged time off for you:\n\nType: ${type||'Vacation'}\nFrom: ${start}\nTo: ${end}\n${notes?'Notes: '+notes+'\n':''}\nView in RadScheduler → My Schedule.`
    });
    return { ok:true, message:`Added ${type} for ${p.last} from ${start} to ${end}.` };
  }

  if(name === 'add_ir_call_blackout'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {physId, start, end, reason} = input;
    const p = S.physicians.find(x=>x.id===physId);
    if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
    if(!p.irCallBlackouts) p.irCallBlackouts = [];
    p.irCallBlackouts.push({id:S.nextId++, start, end, reason: reason||'AI assigned'});
    triggerSave();
    return { ok:true, message:`Added IR call blackout for ${p.last} from ${start} to ${end}.` };
  }

  if(name === 'fill_dr_home_for_ir'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const { month, mode } = input || {};
    if(!month || !/^\d{4}-\d{2}$/.test(month)){
      return { ok:false, error:'month required in YYYY-MM format.' };
    }
    // Delegates to the same two-tier function the UI buttons use, with
    // silent:true so no alert pops up mid-conversation. Returned object's
    // `message` field carries the same human-readable summary the UI shows.
    return fillDRHomeForIR({ mode: mode || 'both', ym: month, silent: true });
  }

  if(name === 'assign_ir_shift'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {physId, date, shift, site, sub, notes, force} = input;
    // rs-v102: parity with the manual addIRShift path — this tool was
    // missing date-format validation, the schedule-lock check, the
    // holiday-blackout check, and cross-type collision detection
    // (DR shifts / IR calls / weekend calls), so the AI could write
    // assignments the UI would have refused.
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { ok:false, error:'date must be in YYYY-MM-DD format (got: ' + JSON.stringify(date) + ').' };
    if(typeof isMonthLocked === 'function' && isMonthLocked(date)) return { ok:false, error:`Month ${date.slice(0,7)} is locked (Schedule Lock). Unlock it in Settings before editing.` };
    const p = S.physicians.find(x=>x.id===physId);
    if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
    if((shift||'1st') !== 'Home' && typeof isHolidayBlackout === 'function' && isHolidayBlackout(date)){
      return { ok:false, error:`${date} is a defined holiday blackout — regular IR shifts are not allowed. Use holiday-call assignment instead.` };
    }
    if((S.irShifts||[]).find(s=>s.physId===physId&&s.date===date))
      return { ok:false, error:`${p.last} already has an IR shift on ${date}.` };
    if(!force && typeof _physBookingsOnDate === 'function'){
      const _b = _physBookingsOnDate(physId, date);
      if(_b.length) return { ok:false, error:`${p.last} already has on ${date}: ${_b.map(x=>x.kind).join(', ')}. One shift per day — remove it first, or retry with force:true.` };
    }
    const siteName = site || p.irSitePrim || '';
    const _violations = _gatherManualRuleViolations(p, {
      physId, date, site:siteName, shift:shift||'1st', sub,
      kind:'ir-shift', shiftKey:'', ym:date.slice(0,7), irGroup:p.irGroup||'',
    });
    if(_violations.length && !force){
      return { ok:false, error:`Physician rule violations:\n  • ${_violations.join('\n  • ')}\n\nRetry with force:true to override.` };
    }
    S.irShifts.push({
      id:S.nextId++, physId, date, shift: shift||'1st',
      site: siteName, sub: sub||'', notes: notes||'AI assigned',
      irGroup: p.irGroup||''
    });
    triggerSave();
    _notify('shiftAssign',{
      physId,
      subject:`New IR shift: ${date} (${shift||'1st'})`,
      body:`You've been assigned a new IR shift:\n\nDate: ${date}\nShift: ${shift||'1st'}\nSite: ${siteName}\n${sub?'Subspecialty: '+sub+'\n':''}\nView in RadScheduler → My Schedule.`
    });
    const _overrideNote = _violations.length ? ` (overrode ${_violations.length} rule violation(s))` : '';
    return {ok:true, message:`Assigned IR ${shift} shift to ${p.last} on ${date} at ${siteName}.${_overrideNote}`};
  }

  // ── SITE MANAGEMENT ───────────────────────────────────────────────────────
  if(name === 'create_site'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {name:siteName, irGroup, address, irAnchorPhysIds, irFillinPhysIds} = input;
    if(!siteName) return { ok:false, error:'Site name required.' };
    if((S.sites||[]).find(s=>s.name===siteName)) return { ok:false, error:`Site "${siteName}" already exists.` };
    const site = {
      name: siteName,
      irGroup: irGroup||null,
      irAnchors: Array.isArray(irAnchorPhysIds)?irAnchorPhysIds.filter(id=>S.physicians.find(p=>p.id===id)):[],
      irFillins: Array.isArray(irFillinPhysIds)?irFillinPhysIds.filter(id=>S.physicians.find(p=>p.id===id)):[]
    };
    if(address) site.address = address;
    S.sites.push(site);
    // Seed default slot map for the new site (mirrors addSite())
    const _slotShifts = siteName==='At Home / Remote' ? ['Home'] : ['1st','2nd','3rd'];
    _slotShifts.forEach(sh=>{
      for(let w=1;w<=5;w++){
        const k=`${siteName}|${w}|${sh}`;
        if(S.siteSlots[k]===undefined) S.siteSlots[k]=0;
      }
    });
    triggerSave();
    if(document.getElementById('sites-list')) renderSitesList();
    return { ok:true, message:`Created site "${siteName}"${irGroup?' in IR '+irGroup:''}${site.irAnchors.length?', '+site.irAnchors.length+' IR anchor(s)':''}${site.irFillins.length?', '+site.irFillins.length+' IR fill-in(s)':''}.` };
  }

  if(name === 'update_site'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {name:siteName, irGroup, address, irAnchorPhysIds, irFillinPhysIds} = input;
    const site = (S.sites||[]).find(s=>s.name===siteName);
    if(!site) return { ok:false, error:`Site "${siteName}" not found.` };
    const changes = [];
    if(irGroup!==undefined){ site.irGroup = irGroup==='none'?null:irGroup; changes.push(`irGroup=${site.irGroup||'(none)'}`); }
    if(address!==undefined){
      // Empty string explicitly clears the address; otherwise trim and set.
      const trimmed = String(address).trim();
      if(trimmed) site.address = trimmed;
      else delete site.address;
      changes.push(trimmed ? `address="${trimmed}"` : 'address=(cleared)');
    }
    if(Array.isArray(irAnchorPhysIds)){
      site.irAnchors = irAnchorPhysIds.filter(id=>S.physicians.find(p=>p.id===id));
      changes.push(`anchors=${site.irAnchors.length}`);
    }
    if(Array.isArray(irFillinPhysIds)){
      site.irFillins = irFillinPhysIds.filter(id=>S.physicians.find(p=>p.id===id));
      changes.push(`fillins=${site.irFillins.length}`);
    }
    triggerSave();
    if(document.getElementById('sites-list')) renderSitesList();
    return { ok:true, message:`Updated site "${siteName}": ${changes.join(', ')||'no changes'}.` };
  }

  if(name === 'delete_site'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {name:siteName} = input;
    const idx = (S.sites||[]).findIndex(s=>s.name===siteName);
    if(idx<0) return { ok:false, error:`Site "${siteName}" not found.` };
    // Manually cascade (same logic as removeSiteWithCascade but without the confirm dialog)
    S.sites.splice(idx,1);
    (S.physicians||[]).forEach(p=>{
      if(p.anchorSite===siteName) p.anchorSite=null;
      if(Array.isArray(p.allowedSites)) p.allowedSites=p.allowedSites.filter(x=>x!==siteName);
      if(Array.isArray(p.siteRules)) p.siteRules=p.siteRules.filter(r=>r.site!==siteName);
      if(Array.isArray(p.dayConditions)) p.dayConditions=p.dayConditions.filter(d=>d.site!==siteName && d.requiredSite!==siteName);
      if(p.irSitePrim===siteName) p.irSitePrim=null;
      if(p.drSite===siteName) p.drSite=null;
    });
    if(Array.isArray(S.drShifts))     S.drShifts=S.drShifts.filter(x=>x.site!==siteName);
    if(Array.isArray(S.irShifts))     S.irShifts=S.irShifts.filter(x=>x.site!==siteName);
    if(Array.isArray(S.weekendCalls)) S.weekendCalls=S.weekendCalls.filter(x=>x.site!==siteName);
    if(Array.isArray(S.irCalls))      S.irCalls=S.irCalls.filter(x=>x.site!==siteName);
    if(Array.isArray(S.openShifts))   S.openShifts=S.openShifts.filter(x=>x.site!==siteName);
    ['siteSlots','irSlots','irShiftSlots','wkndNeeds'].forEach(m=>{
      const map=S[m];
      if(map && typeof map==='object'){
        Object.keys(map).forEach(k=>{
          if(k===siteName || k.startsWith(siteName+'|')) delete map[k];
        });
      }
    });
    if(S.driveTimes && typeof S.driveTimes==='object'){
      Object.keys(S.driveTimes).forEach(k=>{
        if(k.endsWith('|'+siteName)) delete S.driveTimes[k];
      });
    }
    triggerSave();
    if(document.getElementById('sites-list')) renderSitesList();
    return { ok:true, message:`Deleted site "${siteName}" and cascaded removals.` };
  }

  // ── PHYSICIAN MANAGEMENT ──────────────────────────────────────────────────
  if(name === 'update_physician'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {physId, drFte, irFte, irGroup, anchorSite, irSitePrim, allowedSites, drSubs, irSubs, shiftElig} = input;
    const p = S.physicians.find(x=>x.id===physId);
    if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
    const changes = [];
    if(drFte!==undefined){ p.drFte=Math.max(0,Math.min(1,+drFte)); changes.push(`drFte=${p.drFte}`); }
    if(irFte!==undefined){ p.irFte=Math.max(0,Math.min(1,+irFte)); changes.push(`irFte=${p.irFte}`); }
    if(irGroup!==undefined){ p.irGroup = irGroup==='none'?null:irGroup; changes.push(`irGroup=${p.irGroup||'(none)'}`); }
    if(anchorSite!==undefined){ p.anchorSite=anchorSite||null; changes.push(`anchorSite=${p.anchorSite||'(none)'}`); }
    if(irSitePrim!==undefined){ p.irSitePrim=irSitePrim||null; changes.push(`irSitePrim=${p.irSitePrim||'(none)'}`); }
    if(Array.isArray(allowedSites)){ p.allowedSites=allowedSites.slice(); changes.push(`allowedSites=${p.allowedSites.length}`); }
    if(Array.isArray(drSubs)){ p.drSubs=drSubs.slice(); changes.push(`drSubs=${p.drSubs.length}`); }
    if(Array.isArray(irSubs)){ p.irSubs=irSubs.slice(); changes.push(`irSubs=${p.irSubs.length}`); }
    if(shiftElig && typeof shiftElig==='object'){ p.shiftElig={...p.shiftElig, ...shiftElig}; changes.push('shiftElig updated'); }
    // Role recompute if FTE changed
    if(drFte!==undefined || irFte!==undefined){
      if(p.drFte>0 && p.irFte>0) p.role='MIXED';
      else if(p.irFte>0) p.role='IR';
      else p.role='DR';
      changes.push(`role=${p.role}`);
    }
    triggerSave();
    if(document.getElementById('page-physicians')?.classList.contains('on') && typeof renderPhysicians==='function') renderPhysicians();
    return { ok:true, message:`Updated ${p.last}, ${p.first}: ${changes.join(', ')||'no changes'}.` };
  }

  if(name === 'add_physician_site_rule'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {physId, site, blocked, preferred, maxPerMonth, maxPerWeek, allowedShifts} = input;
    const p = S.physicians.find(x=>x.id===physId);
    if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
    if(!(S.sites||[]).find(s=>s.name===site)) return { ok:false, error:`Site "${site}" not found.` };
    if(!Array.isArray(p.siteRules)) p.siteRules=[];
    let rule = p.siteRules.find(r=>r.site===site);
    if(!rule){ rule={site}; p.siteRules.push(rule); }
    if(blocked!==undefined) rule.blocked=!!blocked;
    if(preferred!==undefined) rule.preferred=!!preferred;
    if(maxPerMonth!==undefined) rule.maxPerMonth = maxPerMonth>0?+maxPerMonth:null;
    if(maxPerWeek!==undefined)  rule.maxPerWeek  = maxPerWeek>0?+maxPerWeek:null;
    if(Array.isArray(allowedShifts)) rule.allowedShifts = allowedShifts.slice();
    triggerSave();
    return { ok:true, message:`Site rule for ${p.last} @ ${site}: ${JSON.stringify(rule)}` };
  }

  if(name === 'remove_physician_site_rule'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {physId, site} = input;
    const p = S.physicians.find(x=>x.id===physId);
    if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
    const before = (p.siteRules||[]).length;
    p.siteRules = (p.siteRules||[]).filter(r=>r.site!==site);
    triggerSave();
    return { ok:true, message:`Removed ${before-p.siteRules.length} site rule(s) for ${p.last} @ ${site}.` };
  }

  if(name === 'add_physician_day_condition'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {physId, dow, schedType, requiredSite, notes} = input;
    const p = S.physicians.find(x=>x.id===physId);
    if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
    if(dow<0||dow>6) return { ok:false, error:'dow must be 0-6 (0=Sun).' };
    if(!Array.isArray(p.dayConditions)) p.dayConditions=[];
    const st = schedType||'any';
    p.dayConditions = p.dayConditions.filter(d=>!(d.dow===dow && d.schedType===st));
    p.dayConditions.push({dow, schedType:st, requiredSite: requiredSite||'', notes: notes||''});
    triggerSave();
    const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];
    return { ok:true, message:`${p.last}: on ${dayName}s for ${st}, require site ${requiredSite}.` };
  }

  if(name === 'set_physician_seq_rules'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {physId, maxConsec, minRest, maxWkCalls, notes} = input;
    const p = S.physicians.find(x=>x.id===physId);
    if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
    p.seqRules = p.seqRules || {};
    if(maxConsec!==undefined)  p.seqRules.maxConsec  = +maxConsec||null;
    if(minRest!==undefined)    p.seqRules.minRest    = +minRest||null;
    if(maxWkCalls!==undefined) p.seqRules.maxWkCalls = +maxWkCalls||null;
    if(notes!==undefined)      p.seqRules.notes      = notes;
    triggerSave();
    return { ok:true, message:`Seq rules for ${p.last}: ${JSON.stringify(p.seqRules)}` };
  }

  // ── HOLIDAY DEFINITIONS ───────────────────────────────────────────────────
  if(name === 'create_holiday_definition'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {name:holName, year, dates, drSlots, irNorthSlots, irSouthSlots, notes} = input;
    if(!holName||!year||!Array.isArray(dates)||!dates.length) return { ok:false, error:'name, year, and non-empty dates array required.' };
    if(!S.holidayDefs) S.holidayDefs=[];
    S.holidayDefs.push({
      id: S.nextId++,
      name: holName,
      year: +year,
      dates: dates.slice().sort(),
      drSlots: +drSlots||0,
      irNorthSlots: +irNorthSlots||0,
      irSouthSlots: +irSouthSlots||0,
      notes: notes||''
    });
    triggerSave();
    if(document.getElementById('holdef-list') && typeof renderHolDefList==='function') renderHolDefList();
    return { ok:true, message:`Created holiday "${holName}" (${year}) covering ${dates.length} date(s). Pools: DR=${drSlots||0}, IR-N=${irNorthSlots||0}, IR-S=${irSouthSlots||0}.` };
  }

  // ── NATURAL-LANGUAGE RULES ────────────────────────────────────────────────
  if(name === 'create_natural_language_rule'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {sentence, when, then, enabled} = input;
    if(!sentence||!when||!then||!then.action) return { ok:false, error:'sentence, when, and then.action all required.' };
    if(!Array.isArray(S.natLangRules)) S.natLangRules=[];
    const rule = {
      id: S.nextId++,
      sentence,
      when: {...when},
      then: {...then},
      enabled: enabled!==false,
      createdAt: new Date().toISOString(),
      createdBy: CU?.id||null
    };
    S.natLangRules.push(rule);
    triggerSave();
    if(typeof renderNatLangRules==='function') renderNatLangRules();
    return { ok:true, message:`Created rule #${rule.id}: ${sentence}` };
  }

  if(name === 'list_natural_language_rules'){
    const rules = S.natLangRules||[];
    if(!rules.length) return { ok:true, data:{rules:[]}, message:'No natural-language rules defined.' };
    return { ok:true, data:{rules:rules.map(r=>({
      id:r.id, sentence:r.sentence, enabled:r.enabled,
      when:r.when, then:r.then
    }))}, message:`${rules.length} rule(s) defined.` };
  }

  if(name === 'delete_natural_language_rule'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {ruleId} = input;
    const before = (S.natLangRules||[]).length;
    S.natLangRules = (S.natLangRules||[]).filter(r=>r.id!==ruleId);
    if(S.natLangRules.length===before) return { ok:false, error:`Rule ID ${ruleId} not found.` };
    triggerSave();
    if(typeof renderNatLangRules==='function') renderNatLangRules();
    return { ok:true, message:`Deleted rule ${ruleId}.` };
  }

  if(name === 'toggle_natural_language_rule'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {ruleId, enabled} = input;
    const r = (S.natLangRules||[]).find(x=>x.id===ruleId);
    if(!r) return { ok:false, error:`Rule ID ${ruleId} not found.` };
    r.enabled = !!enabled;
    triggerSave();
    if(typeof renderNatLangRules==='function') renderNatLangRules();
    return { ok:true, message:`Rule ${ruleId} ${r.enabled?'enabled':'disabled'}.` };
  }

  if(name === 'send_notification'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const {physIds, subject, body, kind} = input;
    if(!Array.isArray(physIds) || !physIds.length) return { ok:false, error:'physIds must be a non-empty array of physician IDs.' };
    if(!subject || !body) return { ok:false, error:'subject and body are required.' };
    const kindVal = kind || 'shiftAssign';
    // Resolve to real physicians and check which have linked users
    const resolved = [];
    const missing = [];
    const noEmail = [];
    physIds.forEach(pid => {
      const p = S.physicians.find(x => x.id === pid);
      if(!p){ missing.push(`ID ${pid}`); return; }
      const u = _userForPhys(pid);
      if(!u){ missing.push(`${p.last}, ${p.first} (no linked user)`); return; }
      const addr = _deliveryEmail(u);
      if(!addr || _looksPlaceholder(addr)){ noEmail.push(`${p.last}, ${p.first}`); return; }
      resolved.push({physId: pid, name: `${p.last}, ${p.first}`, email: addr});
    });
    if(!resolved.length){
      return { ok:false, error:`No notifiable physicians. Missing/unlinked: ${missing.join('; ')||'none'}. No valid delivery email: ${noEmail.join('; ')||'none'}. Add delivery emails in 🔔 Notifications or User Management.` };
    }
    // Dispatch — _notify handles the actual edge-function call, pref filtering, admin CC, and logging
    _notify(kindVal, {
      physIds: resolved.map(r => r.physId),
      subject,
      body
    });
    const parts = [`Sent to ${resolved.length} physician(s): ${resolved.map(r=>r.name).join(', ')}.`];
    if(missing.length)  parts.push(`Skipped (no linked account): ${missing.join('; ')}.`);
    if(noEmail.length)  parts.push(`Skipped (no valid delivery email): ${noEmail.join('; ')}.`);
    parts.push(`Note: recipients who disabled "${kindVal}" in their notification preferences will not receive the email.`);
    return { ok:true, message: parts.join(' ') };
  }

  if(name === 'list_physician_rules'){
    const { physId } = input || {};
    const summarize = (p) => ({
      physId: p.id,
      name: `${p.last}, ${p.first}`,
      role: p.role,
      irGroup: p.irGroup || null,
      siteRules:    (p.siteRules    || []).map((r,i)=>({idx:i, ...r})),
      dayConditions:(p.dayConditions|| []).map((r,i)=>({idx:i, ...r})),
      seqRules:      p.seqRules     || null,
      siteSeqRules:(p.siteSeqRules || []).map((r,i)=>({idx:i, ...r})),
      callDayRules:(p.callDayRules || []).map((r,i)=>({idx:i, ...r})),
      tbRules:     (p.tbRules      || []).map((r,i)=>({idx:i, ...r})),
      customRules: (p.customRules  || []).map(r=>({
        id: r.id, text: r.text, severity: r.severity||'warn',
        active: r.active!==false, createdAt: r.createdAt||null
      })),
    });
    if(physId != null){
      const p = S.physicians.find(x=>x.id===physId);
      if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
      return { ok:true, data: summarize(p) };
    }
    return { ok:true, data: (S.physicians||[]).map(summarize) };
  }

  if(name === 'add_physician_custom_rule'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const { physId, text, severity, active } = input || {};
    const p = S.physicians.find(x=>x.id===physId);
    if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
    const cleanText = String(text||'').trim();
    if(!cleanText) return { ok:false, error:'Rule text is required.' };
    const sev = ['info','warn','block'].includes(severity) ? severity : 'warn';
    if(!Array.isArray(p.customRules)) p.customRules = [];
    const rule = {
      id: S.nextId++,
      text: cleanText,
      severity: sev,
      active: active !== false,
      createdAt: new Date().toISOString(),
    };
    p.customRules.push(rule);
    triggerSave();
    if(_srPhysId === physId && document.getElementById('phys-site-rules-wrap')?.style.display !== 'none'){
      renderSiteRulesList();
    }
    return { ok:true, message:`Added ${sev} custom rule to ${p.last}: "${cleanText}".`, ruleId: rule.id };
  }

  if(name === 'update_physician_custom_rule'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const { physId, ruleId, text, severity, active } = input || {};
    const p = S.physicians.find(x=>x.id===physId);
    if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
    const r = (p.customRules||[]).find(x=>x.id===ruleId);
    if(!r) return { ok:false, error:`Custom rule ID ${ruleId} not found on ${p.last}.` };
    const changes = [];
    if(text != null){
      const cleanText = String(text).trim();
      if(!cleanText) return { ok:false, error:'Rule text cannot be empty.' };
      r.text = cleanText; changes.push('text');
    }
    if(severity != null){
      if(!['info','warn','block'].includes(severity)) return { ok:false, error:`severity must be one of info|warn|block.` };
      r.severity = severity; changes.push('severity');
    }
    if(active != null){ r.active = !!active; changes.push('active'); }
    if(!changes.length) return { ok:false, error:'No fields supplied to update.' };
    r.updatedAt = new Date().toISOString();
    triggerSave();
    if(_srPhysId === physId && document.getElementById('phys-site-rules-wrap')?.style.display !== 'none'){
      renderSiteRulesList();
    }
    return { ok:true, message:`Updated ${changes.join(', ')} on ${p.last}'s custom rule #${ruleId}.` };
  }

  if(name === 'delete_physician_custom_rule'){
    if(!adminOk) return { ok:false, error:'Admin access required.' };
    const { physId, ruleId } = input || {};
    const p = S.physicians.find(x=>x.id===physId);
    if(!p) return { ok:false, error:`Physician ID ${physId} not found.` };
    const r = (p.customRules||[]).find(x=>x.id===ruleId);
    if(!r) return { ok:false, error:`Custom rule ID ${ruleId} not found on ${p.last}.` };
    p.customRules = (p.customRules||[]).filter(x=>x.id!==ruleId);
    triggerSave();
    if(_srPhysId === physId && document.getElementById('phys-site-rules-wrap')?.style.display !== 'none'){
      renderSiteRulesList();
    }
    return { ok:true, message:`Deleted custom rule "${r.text}" from ${p.last}.` };
  }

  if(name === 'find_coverage'){
    // Rank-by-eligibility: for the requested date+shift+site, returns a
    // list of physicians scored by:
    //   - hard exclusions filtered out (vacation, conflict, post-call)
    //   - lower fteUtilizationPct = better (under-quota)
    //   - anchor-site preference bonus
    //   - sub-specialty match bonus
    const date = String(input.date || '').slice(0, 10);
    const shift = String(input.shift || '').toLowerCase();
    const site = input.site || null;
    const sub  = input.sub || null;
    const kind = (input.kind || 'dr').toLowerCase();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok:false, error:'date must be YYYY-MM-DD.' };
    const candidates = (S.physicians || []).filter(p => {
      // Sub-eligibility: shifted role must match
      if(kind === 'dr' && (p.drFte || 0) <= 0 && p.role !== 'MIXED') return false;
      if(kind === 'ir' && (p.irFte || 0) <= 0 && p.role !== 'MIXED') return false;
      // Vacations: drop anyone off that day
      if((S.vacations || []).some(v => v.physId === p.id && v.start <= date && v.end >= date)) return false;
      // Already busy on a different shift that day
      if(kind === 'dr' && (S.drShifts || []).some(s => s.physId === p.id && s.date === date && s.shift !== 'Home')) return false;
      if(kind === 'ir' && (S.irShifts || []).some(s => s.physId === p.id && s.date === date && s.shift !== 'Home')) return false;
      // On-call same day = busy
      if((S.irCalls || []).some(c => c.physId === p.id && c.date === date)) return false;
      // Allowed-sites filter
      if(site && Array.isArray(p.allowedSites) && p.allowedSites.length && !p.allowedSites.includes(site)) return false;
      // Shift-eligibility (s1/s2/s3/home/wknd) when set
      const se = p.shiftElig || {};
      const elKey = shift === '1st' ? 's1' : shift === '2nd' ? 's2' : shift === '3rd' ? 's3' : shift === 'home' ? 'home' : shift === 'wknd' ? 'wknd' : null;
      if(elKey && se[elKey] === false) return false;
      return true;
    });
    if(!candidates.length){
      return { ok:true, results:[], message:'No eligible physicians found for that slot. All are vacation, busy, or shift-ineligible.' };
    }
    // Score each candidate.
    const yr = date.slice(0, 4);
    const ym = date.slice(0, 7);
    const scored = candidates.map(p => {
      let score = 0;
      const reasons = [];
      // Anchor site bonus (the physician's preferred site)
      if(site && p.anchorSite === site){ score += 30; reasons.push('anchor site'); }
      // Sub-specialty match
      if(sub){
        const sl = (kind === 'ir' ? p.irSubs : p.drSubs) || [];
        if(sl.includes(sub)){ score += 20; reasons.push('sub match'); }
      }
      // FTE utilization heuristic — count this month's shifts vs FTE
      const monthShifts = (S.drShifts || []).filter(s => s.date.startsWith(ym) && s.physId === p.id && s.shift !== 'Home').length
                       + (S.irShifts || []).filter(s => s.date.startsWith(ym) && s.physId === p.id && s.shift !== 'Home').length
                       + (S.irCalls || []).filter(c => c.date.startsWith(ym) && c.physId === p.id).length;
      const fte = (p.drFte || 0) + (p.irFte || 0) || 0.5;
      const expected = fte * 18; // 18 ≈ workdays/month per 1.0 FTE
      const utilPct = Math.round((monthShifts / Math.max(1, expected)) * 100);
      // Reward under-quota (lower utilization = higher score)
      score += Math.max(0, 100 - utilPct);
      if(utilPct > 110) reasons.push(`over-quota (${utilPct}%)`);
      else if(utilPct < 80) reasons.push(`under-quota (${utilPct}%)`);
      else reasons.push(`on-quota (${utilPct}%)`);
      return { physId:p.id, name:`${p.last}, ${p.first}`, score, utilPct, reasons };
    }).sort((a,b) => b.score - a.score);
    return {
      ok: true,
      date, shift, site, sub, kind,
      results: scored.slice(0, 6),
      message: `Top ${Math.min(6, scored.length)} candidates ranked by eligibility + FTE utilization.`,
    };
  }

  return { ok:false, error:`Unknown tool: ${name}` };
}
