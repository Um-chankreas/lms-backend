const express = require('express');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { authenticateToken, hasRole } = require('../middleware/auth');

const router = express.Router();
const adminOnly = hasRole('admin', 'super_admin');

/**
 * Khmer stories library (sql/058_khmer_stories.sql): famous stories with
 * author / year / summary, split into labelled excerpts that say which essay
 * topics each part of the story works as an example for.
 *
 *   GET    /api/stories?topic=&q=        any signed-in user
 *   GET    /api/stories/:id              story + its excerpts
 *   POST   /api/stories                  admin / super_admin
 *   PUT    /api/stories/:id              admin / super_admin
 *   DELETE /api/stories/:id              admin / super_admin
 *   POST   /api/stories/:id/excerpts     admin / super_admin
 *   PUT    /api/stories/:id/excerpts/:excerptId
 *   DELETE /api/stories/:id/excerpts/:excerptId
 */

const clean = (v) => (typeof v === 'string' ? v.trim() : v);
const toList = (v) => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []);

function storyFields(body) {
  const out = {};
  for (const k of ['title_km', 'title_en', 'author', 'summary_km', 'summary_en']) {
    if (body[k] !== undefined) out[k] = clean(body[k]) || null;
  }
  if (body.year !== undefined) {
    const y = parseInt(body.year, 10);
    out.year = Number.isFinite(y) ? y : null;
  }
  if (body.themes !== undefined) out.themes = toList(body.themes);
  return out;
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    const topic = String(req.query.topic || '').trim();
    const q = String(req.query.q || '').trim();

    let storyIds = null;
    if (topic) {
      // A story matches a topic if it lists it as a theme, or any of its
      // excerpts is usable for it.
      const { data: ex } = await supabase
        .from('khmer_story_excerpts').select('story_id').contains('usable_for_topics', [topic]);
      const { data: th } = await supabase
        .from('khmer_stories').select('id').contains('themes', [topic]);
      storyIds = [...new Set([...(ex || []).map(r => r.story_id), ...(th || []).map(r => r.id)])];
      if (storyIds.length === 0) return res.json({ success: true, data: { stories: [] } });
    }

    let query = supabase
      .from('khmer_stories')
      .select('id, title_km, title_en, author, year, summary_km, summary_en, themes')
      .order('year', { ascending: true, nullsFirst: false });
    if (storyIds) query = query.in('id', storyIds);
    if (q) {
      const term = q.replace(/[%,()]/g, ' ');
      query = query.or(`title_km.ilike.%${term}%,title_en.ilike.%${term}%,author.ilike.%${term}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: { stories: data || [] } });
  } catch (err) {
    console.error('Stories list error:', err);
    res.status(500).json({ success: false, error: 'Failed to load stories' });
  }
});

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { data: story } = await supabase
      .from('khmer_stories').select('*').eq('id', req.params.id).maybeSingle();
    if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

    const { data: excerpts, error } = await supabase
      .from('khmer_story_excerpts').select('*').eq('story_id', story.id)
      .order('order_number', { ascending: true });
    if (error) throw error;

    res.json({ success: true, data: { story: { ...story, excerpts: excerpts || [] } } });
  } catch (err) {
    console.error('Story fetch error:', err);
    res.status(500).json({ success: false, error: 'Failed to load story' });
  }
});

router.post('/', authenticateToken, adminOnly, async (req, res) => {
  try {
    const fields = storyFields(req.body || {});
    if (!fields.title_km) return res.status(400).json({ success: false, error: 'title_km is required' });

    const { data, error } = await supabase
      .from('khmer_stories')
      .insert({ id: uuidv4(), ...fields })
      .select().single();
    if (error) throw error;
    res.status(201).json({ success: true, data: { story: data } });
  } catch (err) {
    console.error('Story create error:', err);
    res.status(500).json({ success: false, error: 'Failed to create story' });
  }
});

router.put('/:id', authenticateToken, adminOnly, async (req, res) => {
  try {
    const fields = storyFields(req.body || {});
    if (fields.title_km === null) return res.status(400).json({ success: false, error: 'title_km cannot be empty' });

    const { data, error } = await supabase
      .from('khmer_stories')
      .update({ ...fields, updated_at: new Date() })
      .eq('id', req.params.id)
      .select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Story not found' });
    res.json({ success: true, data: { story: data } });
  } catch (err) {
    console.error('Story update error:', err);
    res.status(500).json({ success: false, error: 'Failed to update story' });
  }
});

router.delete('/:id', authenticateToken, adminOnly, async (req, res) => {
  try {
    const { error } = await supabase.from('khmer_stories').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Story delete error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete story' });
  }
});

router.post('/:id/excerpts', authenticateToken, adminOnly, async (req, res) => {
  try {
    const { label, excerpt_km, usable_for_topics, order_number } = req.body || {};
    if (!clean(label) || !clean(excerpt_km)) {
      return res.status(400).json({ success: false, error: 'label and excerpt_km are required' });
    }
    const { data: story } = await supabase
      .from('khmer_stories').select('id').eq('id', req.params.id).maybeSingle();
    if (!story) return res.status(404).json({ success: false, error: 'Story not found' });

    const { data, error } = await supabase
      .from('khmer_story_excerpts')
      .insert({
        id: uuidv4(),
        story_id: story.id,
        label: clean(label),
        excerpt_km: clean(excerpt_km),
        usable_for_topics: toList(usable_for_topics),
        order_number: Number.isFinite(Number(order_number)) ? Number(order_number) : 0
      })
      .select().single();
    if (error) throw error;
    res.status(201).json({ success: true, data: { excerpt: data } });
  } catch (err) {
    console.error('Excerpt create error:', err);
    res.status(500).json({ success: false, error: 'Failed to create excerpt' });
  }
});

router.put('/:id/excerpts/:excerptId', authenticateToken, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const update = {};
    if (b.label !== undefined) update.label = clean(b.label);
    if (b.excerpt_km !== undefined) update.excerpt_km = clean(b.excerpt_km);
    if (b.usable_for_topics !== undefined) update.usable_for_topics = toList(b.usable_for_topics);
    if (b.order_number !== undefined) update.order_number = Number(b.order_number) || 0;
    if (update.label === '' || update.excerpt_km === '') {
      return res.status(400).json({ success: false, error: 'label and excerpt_km cannot be empty' });
    }

    const { data, error } = await supabase
      .from('khmer_story_excerpts')
      .update(update)
      .eq('id', req.params.excerptId)
      .eq('story_id', req.params.id)
      .select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Excerpt not found' });
    res.json({ success: true, data: { excerpt: data } });
  } catch (err) {
    console.error('Excerpt update error:', err);
    res.status(500).json({ success: false, error: 'Failed to update excerpt' });
  }
});

router.delete('/:id/excerpts/:excerptId', authenticateToken, adminOnly, async (req, res) => {
  try {
    const { error } = await supabase
      .from('khmer_story_excerpts').delete()
      .eq('id', req.params.excerptId).eq('story_id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Excerpt delete error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete excerpt' });
  }
});

module.exports = router;
