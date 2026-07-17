/**
 * Call Review — upload recruit call recordings, transcribe (STT), coach with Grok.
 * Stores reviews in localStorage (browser only).
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'recruitingCallReviews';
  const MAX_BYTES = 25 * 1024 * 1024;

  const el = (id) => document.getElementById(id);

  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
    else console.log('[call-review]', msg);
  }

  function loadReviews() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveReviews(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 30)));
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function getProfileBits() {
    try {
      if (typeof window.getUserProfile === 'function') return window.getUserProfile();
      return JSON.parse(localStorage.getItem('userProfile') || '{}');
    } catch (e) {
      return {};
    }
  }

  function getRuoffSnippet() {
    if (typeof window.getRuoffFactContext === 'function') {
      try {
        return window.getRuoffFactContext('recruiting differentiation process culture', 6) || '';
      } catch (e) {}
    }
    return '';
  }

  const TRANSCRIBE_STEPS = [
    {
      label: 'Secure upload',
      detail: 'Sending audio through the proxy. The file is used for this request only.'
    },
    {
      label: 'Speech-to-text',
      detail: 'Grok STT is converting speech into text. A 10–15 min call often takes 30–90 seconds.'
    },
    {
      label: 'Formatting the transcript',
      detail: 'Cleaning spacing and lines so you can edit before Analyze & Coach.'
    },
    {
      label: 'Finishing up',
      detail: 'Almost ready — keep this tab open until the modal closes.'
    }
  ];

  const ANALYZE_STEPS = [
    {
      label: 'Reading the conversation',
      detail: 'Loading the full transcript into the coaching model.'
    },
    {
      label: 'Objection handling (top priority)',
      detail: 'Did they accept the first “no” too quickly? Strong follow-ups vs. soft exits?'
    },
    {
      label: 'Clint / leadership advance',
      detail: 'Did they ask for a short Clint call, frame it as low-risk, and handle hesitation?'
    },
    {
      label: 'Scorecard, rewrites & drills',
      detail: 'Building weighted scores, better lines, and 3 practice focuses for the next call.'
    }
  ];

  const TRANSCRIBE_TIPS = TRANSCRIBE_STEPS.map((s) => s.detail);
  const ANALYZE_TIPS = ANALYZE_STEPS.map((s) => s.detail);

  let progressUi = {
    mode: null,
    stepIndex: 0,
    startedAt: 0,
    tickTimer: null,
    stepTimer: null
  };

  function clearProgressUiTimers() {
    if (progressUi.tickTimer) {
      clearInterval(progressUi.tickTimer);
      progressUi.tickTimer = null;
    }
    if (progressUi.stepTimer) {
      clearInterval(progressUi.stepTimer);
      progressUi.stepTimer = null;
    }
  }

  function formatElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
  }

  function expectedWaitCopy(mode, meta) {
    if (mode === 'transcribe') {
      const mb = meta && meta.bytes ? meta.bytes / (1024 * 1024) : 0;
      if (mb >= 8) return 'Larger files often take 1–2 minutes.';
      if (mb >= 3) return 'Typical wait: about 30–90 seconds.';
      return 'Typical wait: about 15–45 seconds.';
    }
    return 'Typical wait: about 20–60 seconds depending on transcript length.';
  }

  function renderProgressPanel(mode, stepIndex, meta) {
    const panel = document.getElementById('plan-enrich-panel');
    if (!panel) return;

    const steps = mode === 'analyze' ? ANALYZE_STEPS : TRANSCRIBE_STEPS;
    const idx = Math.min(Math.max(0, stepIndex), steps.length - 1);
    const pct = Math.round(((idx + 1) / steps.length) * 100);
    const elapsed = formatElapsed(Date.now() - (progressUi.startedAt || Date.now()));
    const fileLine =
      mode === 'transcribe' && meta && meta.fileName
        ? `<div class="text-left text-xs text-gray-500 dark:text-gray-400 mb-3 rounded-xl bg-gray-50 dark:bg-gray-800/80 px-3 py-2 border border-gray-100 dark:border-gray-700">
             <span class="font-semibold text-[#002B5C] dark:text-gray-200">File:</span>
             ${escapeHtml(meta.fileName)}${meta.bytes ? ` · ${escapeHtml(formatBytes(meta.bytes))}` : ''}
           </div>`
        : mode === 'analyze' && meta && meta.chars
          ? `<div class="text-left text-xs text-gray-500 dark:text-gray-400 mb-3 rounded-xl bg-gray-50 dark:bg-gray-800/80 px-3 py-2 border border-gray-100 dark:border-gray-700">
               <span class="font-semibold text-[#002B5C] dark:text-gray-200">Transcript:</span>
               ~${Math.round(meta.chars / 100) * 100} characters${meta.stage ? ` · stage: ${escapeHtml(meta.stage)}` : ''}
             </div>`
          : '';

    const stepsHtml = steps
      .map((step, i) => {
        let icon = 'fa-circle text-gray-300';
        let row = 'opacity-55';
        let labelCls = 'text-gray-600 dark:text-gray-400';
        if (i < idx) {
          icon = 'fa-check-circle text-emerald-500';
          row = 'opacity-100';
          labelCls = 'text-[#002B5C] dark:text-gray-100';
        } else if (i === idx) {
          icon = 'fa-spinner fa-spin text-[#00A89D]';
          row = 'opacity-100';
          labelCls = 'text-[#002B5C] dark:text-white font-semibold';
        }
        return `<li class="flex gap-3 text-left ${row}">
          <i class="fas ${icon} mt-0.5 shrink-0 w-4 text-center" aria-hidden="true"></i>
          <div class="min-w-0">
            <div class="text-sm ${labelCls}">${escapeHtml(step.label)}</div>
            <div class="text-xs text-gray-500 dark:text-gray-400 leading-snug mt-0.5">${escapeHtml(step.detail)}</div>
          </div>
        </li>`;
      })
      .join('');

    panel.innerHTML = `
      <div class="mt-5 text-left" id="call-review-progress-panel">
        ${fileLine}
        <div class="flex items-center justify-between gap-3 mb-2 text-xs text-gray-500 dark:text-gray-400">
          <span>Step ${idx + 1} of ${steps.length}</span>
          <span><span class="font-semibold text-[#002B5C] dark:text-gray-200">Elapsed</span> ${elapsed}</span>
        </div>
        <div class="h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden mb-4" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
          <div class="h-full rounded-full bg-gradient-to-r from-[#00A89D] to-[#002B5C] transition-all duration-700" style="width:${pct}%"></div>
        </div>
        <ol class="space-y-3 m-0 p-0 list-none">${stepsHtml}</ol>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-4 mb-0 leading-relaxed">
          ${escapeHtml(expectedWaitCopy(mode, meta))} Don’t close or refresh this tab.
        </p>
      </div>`;
  }

  function showWorkModal(title, tips, mode, meta) {
    clearProgressUiTimers();
    progressUi.mode = mode;
    progressUi.stepIndex = 0;
    progressUi.startedAt = Date.now();
    progressUi.meta = meta || {};

    if (typeof window.showLoadingWithTips === 'function') {
      window.showLoadingWithTips(tips, title);
    } else if (typeof window.forceShowGlobalLoading === 'function') {
      window.forceShowGlobalLoading(title);
    }

    // Prefer a calmer navy title for call-review (less “carnival” orange)
    const titleEl = document.getElementById('global-loading-title');
    if (titleEl) {
      titleEl.textContent = title;
      titleEl.classList.remove('text-[#F15A29]');
      titleEl.classList.add('text-[#002B5C]', 'dark:text-white');
    }

    const footerHint = document.querySelector('#global-loading .mt-6.pt-4.border-t');
    if (footerHint && !footerHint.id) {
      footerHint.textContent =
        mode === 'transcribe'
          ? 'Speech-to-text can take a bit — longer audio needs more time.'
          : 'Coaching prioritizes objections + advancing a Clint / leadership call.';
    }

    renderProgressPanel(mode, 0, progressUi.meta);

    progressUi.tickTimer = setInterval(() => {
      renderProgressPanel(progressUi.mode, progressUi.stepIndex, progressUi.meta);
    }, 1000);

    // Advance checklist slowly so wait feels informed (does not claim server steps)
    const maxStep = (mode === 'analyze' ? ANALYZE_STEPS : TRANSCRIBE_STEPS).length - 1;
    progressUi.stepTimer = setInterval(() => {
      if (progressUi.stepIndex < maxStep) {
        progressUi.stepIndex += 1;
        renderProgressPanel(progressUi.mode, progressUi.stepIndex, progressUi.meta);
      }
    }, mode === 'transcribe' ? 9000 : 7000);
  }

  function hideWorkModal() {
    clearProgressUiTimers();
    progressUi.mode = null;
    const panel = document.getElementById('plan-enrich-panel');
    if (panel) panel.innerHTML = '';
    const titleEl = document.getElementById('global-loading-title');
    if (titleEl) {
      titleEl.classList.add('text-[#F15A29]');
      titleEl.classList.remove('text-[#002B5C]', 'dark:text-white');
    }
    if (typeof window.hideLoading === 'function') window.hideLoading();
  }

  function setButtonBusy(btn, busy, idleHtml) {
    if (!btn) return;
    btn.disabled = !!busy;
    if (busy) {
      if (!btn.dataset.idleHtml) btn.dataset.idleHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Working…';
    } else if (btn.dataset.idleHtml) {
      btn.innerHTML = btn.dataset.idleHtml;
      delete btn.dataset.idleHtml;
    } else if (idleHtml) {
      btn.innerHTML = idleHtml;
    }
  }

  /**
   * @param {boolean} busy
   * @param {string} [label]
   * @param {{ mode?: 'transcribe'|'analyze'|'done'|'error', activeBtn?: 'transcribe'|'analyze', meta?: object }} [opts]
   */
  function setBusy(busy, label, opts) {
    opts = opts || {};
    const btnT = el('call-review-transcribe');
    const btnA = el('call-review-analyze');
    const status = el('call-review-status');

    if (busy) {
      setButtonBusy(btnT, opts.activeBtn === 'transcribe');
      setButtonBusy(btnA, opts.activeBtn === 'analyze');
      if (btnT && opts.activeBtn !== 'transcribe') btnT.disabled = true;
      if (btnA && opts.activeBtn !== 'analyze') btnA.disabled = true;
      if (opts.mode === 'transcribe') {
        showWorkModal('Transcribing your call…', TRANSCRIBE_TIPS, 'transcribe', opts.meta || {});
      } else if (opts.mode === 'analyze') {
        showWorkModal('Analyzing & coaching…', ANALYZE_TIPS, 'analyze', opts.meta || {});
      }
    } else {
      hideWorkModal();
      setButtonBusy(btnT, false);
      setButtonBusy(btnA, false);
      if (btnT) btnT.disabled = false;
      if (btnA) btnA.disabled = false;
    }

    if (!status) return;
    const text = label || (busy ? 'Working…' : '');
    if (!text) {
      status.classList.add('hidden');
      status.innerHTML = '';
      status.className =
        'hidden rounded-2xl border px-4 py-3 text-sm font-medium m-0 flex items-start gap-3';
      return;
    }

    let tone =
      'border-[#00A89D]/40 bg-[#00A89D]/10 text-[#002B5C] dark:text-teal-100 dark:bg-[#00A89D]/15';
    let icon = 'fa-spinner fa-spin text-[#00A89D]';
    if (opts.mode === 'done') {
      tone =
        'border-emerald-300/70 bg-emerald-50 text-emerald-900 dark:bg-emerald-900/25 dark:text-emerald-100';
      icon = 'fa-check-circle text-emerald-600 dark:text-emerald-400';
    } else if (opts.mode === 'error') {
      tone = 'border-red-300/70 bg-red-50 text-red-800 dark:bg-red-900/25 dark:text-red-100';
      icon = 'fa-exclamation-circle text-red-500';
    } else if (busy) {
      tone =
        'border-[#F15A29]/40 bg-[#F15A29]/10 text-[#002B5C] dark:text-orange-100 dark:bg-[#F15A29]/15';
      icon = 'fa-spinner fa-spin text-[#F15A29]';
    }

    status.className =
      'rounded-2xl border px-4 py-3.5 text-sm sm:text-base font-semibold m-0 flex items-start gap-3 shadow-sm ' +
      tone;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.innerHTML =
      `<i class="fas ${icon} mt-0.5 text-lg shrink-0" aria-hidden="true"></i>` +
      `<span class="leading-snug">${escapeHtml(text)}</span>`;
  }

  function selectedFile() {
    const input = el('call-review-file');
    return input && input.files && input.files[0] ? input.files[0] : null;
  }

  function onFilePicked() {
    const file = selectedFile();
    const meta = el('call-review-file-meta');
    if (!meta) return;
    if (!file) {
      meta.textContent = 'No file selected';
      return;
    }
    if (file.size > MAX_BYTES) {
      meta.textContent = `Too large (${formatBytes(file.size)}). Max ${formatBytes(MAX_BYTES)}.`;
      meta.classList.add('text-red-500');
      toast('File exceeds 25 MB limit', 'error');
      return;
    }
    meta.classList.remove('text-red-500');
    meta.textContent = `${file.name} · ${formatBytes(file.size)} · ${file.type || 'audio'}`;
  }

  async function transcribe() {
    const file = selectedFile();
    if (!file) {
      toast('Choose an audio file first', 'warning');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast('File too large (max 25 MB)', 'error');
      return;
    }
    if (typeof window.transcribeAudioFile !== 'function') {
      toast('Transcription helper not loaded', 'error');
      return;
    }

    setBusy(true, 'Transcribing your recording with Grok STT — please wait…', {
      mode: 'transcribe',
      activeBtn: 'transcribe',
      meta: { fileName: file.name, bytes: file.size }
    });
    try {
      const { text } = await window.transcribeAudioFile(file);
      const ta = el('call-review-transcript');
      if (ta) ta.value = text || '';
      if (!text) {
        toast('Transcription returned empty text — try another format (mp3/m4a/wav)', 'warning');
        setBusy(false, 'Transcript came back empty — try another format (mp3 / m4a / wav).', {
          mode: 'error'
        });
      } else {
        toast('Transcript ready — edit if needed, then Analyze', 'success');
        setBusy(false, 'Transcript ready. Review or edit it below, then click Analyze & Coach.', {
          mode: 'done'
        });
        ta?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (err) {
      console.error('[call-review] STT', err);
      toast(err.message || 'Transcription failed', 'error');
      setBusy(false, err.message || 'Transcription failed. Check your connection and try again.', {
        mode: 'error'
      });
    }
  }

  function buildAnalysisPrompt(transcript, meta) {
    const profile = getProfileBits();
    const facts = getRuoffSnippet();
    const stage = meta.stage || 'unknown';
    const notes = meta.notes || '';
    const name = profile.name || 'Recruiter';
    const vision = window.RECRUITING_PLAN_2026?.vision;
    const keys = (window.RECRUITING_PLAN_2026?.keysToSuccess || []).slice(0, 6).join(' ');

    return `You are a senior Ruoff Mortgage recruiting coach reviewing a real conversation between a Ruoff recruiter and an LO prospect (or related recruiting call). Your style matches our Voice Roleplay / recruiting coach: value-first, relationship-driven, warm but direct — a senior mentor who is supportive and specific, never fluffy, never pushy-for-pushy-sake.

## PURPOSE
Give structured coaching feedback on this call. Place MAJOR emphasis on two skills above everything else:
1) Overcoming objections
2) Moving the prospect toward a short call with Clint / leadership

## CORE PHILOSOPHY
- Value-first and relationship-driven.
- The ultimate goal of almost every call is to get the prospect on a short call with Clint / leadership.
- Feedback must be practical, specific, and actionable.
- Be more critical and detailed when the recruiter accepted objections too easily OR failed to push toward a Clint / leadership call.
- Reference real patterns we see in weak calls when they appear (e.g. defaulting to a social connect too fast, weak follow-up questions, vague “I’ll check in later,” taking the first “no” and pivoting away, no clear who/when next step).

## KEY EVALUATION PRIORITIES (strict order of importance)

### 1. Objection Handling — HIGHEST PRIORITY
Evaluate carefully:
- Did they accept the first “no” too quickly?
- Did they ask strong follow-up questions instead of moving on?
- How well did they handle common objections (“I’m happy where I am”, “I just made a move”, “I’m too busy”, “I’m winding down my career”, timing objections, etc.)?
- Did they reframe or push back naturally without being pushy?

### 2. Moving Toward a Clint / Leadership Call — VERY HIGH PRIORITY
Evaluate carefully:
- Did they attempt to book time with Clint / leadership?
- How naturally and confidently did they make the ask?
- Did they position the Clint call as low-risk / high-value?
- Did they overcome resistance when the prospect hesitated?

### 3. Next Step Clarity
- Did they lock in a clear next step (who is calling whom and when)?

### Other areas (lower priority — still score, but do not let them dominate the debrief)
- Quality of the opener and rapport
- Strength of discovery questions
- Listening and follow-up
- Natural use of Ruoff differentiators / vision when relevant (only accurate claims; never invent company facts)

## OVERALL SCORE GUIDANCE
Weight the 0–10 overall score heavily toward objection handling + Clint/leadership advance + next-step assertiveness. A polished opener with weak objection work and no Clint ask should NOT score high. A scrappy opener with strong objection work and a clear Clint/next-step push can score well.

## RECRUITER CONTEXT
- Name: ${name}
- Market/focus: ${profile.location || profile.localArea || profile.market || 'not set'}
- Call stage (user-provided): ${stage}
- Recruiter notes: ${notes || 'none'}

## RUOFF 2026 VISION (use when scoring differentiators / story — never invent claims)
${vision?.statement || ''} ${vision?.how || ''}

## KEYS TO SUCCESS (plan context)
${keys || 'Human first, relationships first, value before pitch, Shape logging, long game.'}

## RUOFF FACTS (use only when scoring differentiators — do not invent company claims)
${facts || '(no vault facts loaded)'}

## TRANSCRIPT
"""
${transcript.slice(0, 28000)}
"""

## REQUIRED OUTPUT (clean markdown — use these exact section headings)

### 1. Overall Score
- Score out of 10 (one number)
- One-sentence summary that names the biggest win and the biggest miss, with emphasis on objections and/or Clint advance when relevant

### 2. What Went Well
- 3–5 specific strengths with short transcript quotes when possible

### 3. Key Coaching Opportunities
- 4–6 bullets — put EXTRA focus here on objection handling and the Clint / leadership push
- Call out soft exits, social-only pivots, weak follow-ups, and missed asks when present

### 4. Detailed Scorecard
For EACH category below: **Score (1–5)** + 1–3 sentences of commentary.
Give deeper commentary on Objection Handling and Moving Toward a Clint Call than on lower-priority categories.

| Category | Focus |
| --- | --- |
| Opener & Rapport | Warmth, credibility, reason for the call |
| Discovery Quality | Questions that uncover fit, timing, motivation |
| Objection Handling | Follow-ups, reframes, not accepting first “no” |
| Moving Toward a Clint Call | Ask quality, low-risk framing, handling hesitation |
| Next Step Clarity & Assertiveness | Who calls whom, when, locked commitment |
| Listening & Follow-up Questions | Heard them; dug in vs. talking over |
| Use of Ruoff Differentiators | Accurate, natural, only when relevant |

### 5. Specific Suggested Rewrites
- Rewrite at least 3 weak moments as stronger recruiter language (relationship-first, never pushy)
- Prioritize rewrites for: (a) objection moments and (b) Clint / leadership asks
- Format each as: **Moment** (brief) → **What they said / did** → **Better line**

### 6. 3 Focused Practice Recommendations
- Exactly 3 drills for the next call
- Heavily weight these toward objection handling and confidently asking for Clint / leadership conversations
- Make each drill concrete (what to practice, how, success look-like)

## HARD RULES
- Be supportive but direct (senior mentor tone).
- Prioritize coaching on overcoming objections and confidently moving to a Clint conversation above all other skills.
- Be more critical and detailed when objections were accepted too easily or there was no real push toward Clint / leadership.
- Keep feedback practical and specific to THIS transcript — no generic fluff.
- If the transcript is incomplete or unclear, say so.
- Do not invent facts not in the transcript or the Ruoff facts provided.
- Do not invent compensation, guarantees, or company claims.`;
  }

  async function analyze() {
    const ta = el('call-review-transcript');
    const transcript = (ta?.value || '').trim();
    if (!transcript || transcript.length < 40) {
      toast('Need a transcript first (transcribe or paste)', 'warning');
      return;
    }
    if (typeof window.callGrokAPI !== 'function') {
      toast('Grok API client not loaded', 'error');
      return;
    }

    const stage = el('call-review-stage')?.value || '';
    const notes = el('call-review-notes')?.value || '';
    setBusy(true, 'Analyzing the call and building your coaching debrief…', {
      mode: 'analyze',
      activeBtn: 'analyze',
      meta: {
        chars: transcript.length,
        stage: stage || ''
      }
    });
    const out = el('call-review-output');
    if (out) {
      out.classList.remove('hidden');
      out.innerHTML =
        '<p class="text-sm text-gray-600 dark:text-gray-300 m-0 flex items-center gap-2">' +
        '<i class="fas fa-spinner fa-spin text-[#00A89D]" aria-hidden="true"></i> ' +
        'Coaching analysis in progress — full-screen progress is also open…</p>';
    }

    try {
      const prompt = buildAnalysisPrompt(transcript, { stage, notes });
      const raw = await window.callGrokAPI(prompt, {
        temperature: 0.4,
        max_tokens: 2800
      });
      const md = String(raw || '').trim();
      renderAnalysis(md);

      const file = selectedFile();
      const review = {
        id: 'cr-' + Date.now(),
        at: new Date().toISOString(),
        fileName: file?.name || 'pasted-transcript',
        stage,
        notes,
        transcript: transcript.slice(0, 50000),
        analysis: md
      };
      const list = loadReviews();
      list.unshift(review);
      saveReviews(list);
      renderHistory();
      toast('Call review saved in this browser', 'success');
      setBusy(false, 'Analysis complete — scroll down for your coaching debrief (also saved on the right).', {
        mode: 'done'
      });
      out?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error('[call-review] analyze', err);
      if (out) {
        out.innerHTML = `<p class="text-sm text-red-500 m-0">${escapeHtml(err.message || 'Analysis failed')}</p>`;
      }
      toast(err.message || 'Analysis failed', 'error');
      setBusy(false, err.message || 'Analysis failed. Try again in a moment.', { mode: 'error' });
    }
  }

  function extractOverallScore(md) {
    const text = String(md || '');
    // Prefer "Overall Score" / "Score: 8/10" patterns near the top
    const patterns = [
      /overall\s*score[^0-9]{0,40}(\d{1,2}(?:\.\d+)?)\s*(?:\/\s*10|out of 10)/i,
      /(\d{1,2}(?:\.\d+)?)\s*\/\s*10/,
      /score[:\s]+(\d{1,2}(?:\.\d+)?)\s*(?:\/\s*10)?/i
    ];
    for (let i = 0; i < patterns.length; i++) {
      const m = text.match(patterns[i]);
      if (m) {
        const n = parseFloat(m[1]);
        if (!Number.isNaN(n) && n >= 0 && n <= 10) return n;
      }
    }
    return null;
  }

  function scoreTone(score) {
    if (score == null) return { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-[#002B5C] dark:text-white', ring: 'ring-gray-200' };
    if (score >= 8) return { bg: 'bg-emerald-50 dark:bg-emerald-900/30', text: 'text-emerald-800 dark:text-emerald-200', ring: 'ring-emerald-200/80' };
    if (score >= 6) return { bg: 'bg-amber-50 dark:bg-amber-900/25', text: 'text-amber-900 dark:text-amber-100', ring: 'ring-amber-200/70' };
    return { bg: 'bg-orange-50 dark:bg-orange-900/20', text: 'text-orange-900 dark:text-orange-100', ring: 'ring-orange-200/70' };
  }

  function renderAnalysis(md) {
    const out = el('call-review-output');
    if (!out) return;
    out.classList.remove('hidden');
    out.className =
      'ai-output max-w-none rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-0 overflow-hidden';

    const bodyHtml =
      typeof window.marked?.parse === 'function'
        ? window.marked.parse(md)
        : `<pre class="whitespace-pre-wrap text-sm m-0 p-5">${escapeHtml(md)}</pre>`;

    const score = extractOverallScore(md);
    const tone = scoreTone(score);
    const scoreChip =
      score != null
        ? `<div class="shrink-0 rounded-2xl ${tone.bg} ${tone.text} ring-1 ${tone.ring} px-4 py-3 text-center min-w-[4.5rem]">
             <div class="text-[10px] font-bold uppercase tracking-wider opacity-70">Score</div>
             <div class="text-2xl font-bold leading-none mt-1">${escapeHtml(String(score))}<span class="text-sm font-semibold opacity-60">/10</span></div>
           </div>`
        : '';

    out.innerHTML = `
      <div class="ai-output-header px-5 pt-5 pb-0 border-0 mb-0">
        <div>
          <div class="ai-output-kicker"><i class="fas fa-headset" aria-hidden="true"></i> Call review</div>
          <h3 class="ai-output-title">Coaching debrief</h3>
          <p class="text-xs text-gray-500 dark:text-gray-400 m-0 mt-1">Objection handling &amp; Clint / leadership advance weighted highest</p>
        </div>
        ${scoreChip}
      </div>
      <div class="ai-output-body prose dark:prose-invert max-w-none px-5 pb-5 pt-3 text-[15px] leading-relaxed">
        ${bodyHtml}
      </div>`;
  }

  function renderHistory() {
    const host = el('call-review-history');
    if (!host) return;
    const list = loadReviews();
    if (!list.length) {
      host.innerHTML = '<p class="text-sm text-gray-500 m-0">No saved reviews yet.</p>';
      return;
    }
    host.innerHTML = list
      .slice(0, 12)
      .map(
        (r) => `
      <button type="button" data-review-id="${escapeHtml(r.id)}" class="call-review-hist-item w-full text-left rounded-xl border border-gray-200 dark:border-gray-700 p-3 hover:border-[#00A89D] transition">
        <div class="flex justify-between gap-2 text-xs text-gray-500 mb-1">
          <span>${escapeHtml(new Date(r.at).toLocaleString())}</span>
          <span>${escapeHtml(r.stage || '—')}</span>
        </div>
        <div class="text-sm font-semibold text-[#002B5C] dark:text-white truncate">${escapeHtml(r.fileName || 'Review')}</div>
      </button>`
      )
      .join('');

    host.querySelectorAll('.call-review-hist-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-review-id');
        const r = loadReviews().find((x) => x.id === id);
        if (!r) return;
        if (el('call-review-transcript')) el('call-review-transcript').value = r.transcript || '';
        if (el('call-review-stage') && r.stage) el('call-review-stage').value = r.stage;
        if (el('call-review-notes')) el('call-review-notes').value = r.notes || '';
        renderAnalysis(r.analysis || '');
        toast('Loaded saved review', 'info');
      });
    });
  }

  function wireDropZone() {
    const zone = el('call-review-dropzone');
    const input = el('call-review-file');
    if (!zone || !input) return;

    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('border-[#00A89D]', 'bg-[#00A89D]/5');
    });
    zone.addEventListener('dragleave', () => {
      zone.classList.remove('border-[#00A89D]', 'bg-[#00A89D]/5');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('border-[#00A89D]', 'bg-[#00A89D]/5');
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      const dt = new DataTransfer();
      dt.items.add(f);
      input.files = dt.files;
      onFilePicked();
    });
    input.addEventListener('change', onFilePicked);
  }

  function wire() {
    wireDropZone();
    el('call-review-transcribe')?.addEventListener('click', () => transcribe());
    el('call-review-analyze')?.addEventListener('click', () => analyze());
    el('call-review-clear')?.addEventListener('click', () => {
      if (el('call-review-transcript')) el('call-review-transcript').value = '';
      if (el('call-review-output')) {
        el('call-review-output').classList.add('hidden');
        el('call-review-output').innerHTML = '';
      }
      if (el('call-review-file')) el('call-review-file').value = '';
      onFilePicked();
    });
    renderHistory();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  console.log('%c[call-review] Upload + STT + coaching analysis ready', 'color:#00A89D');
})();
