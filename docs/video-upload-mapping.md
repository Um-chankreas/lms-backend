# Video ↔ lesson mapping (for the upload bot)

How a video file on disk ends up attached to the right chapter / unit in Supabase, and what a bot has to call to do it.

## 1. The content hierarchy

```
courses              a class, e.g. "History Grade 12"
 └─ lessons          a CHAPTER ("ជំពូកទី១ …")            table: lessons
     └─ lesson_units a UNIT inside the chapter             table: lesson_units
```

Note the naming: in the database and API a **chapter is a `lesson`**, and a **unit is a `lesson_unit`**. The mobile app and web say "chapter" / "unit".

## 2. Where a video can be attached

| Slot | Table / column | Duration column | Storage folder | Required? |
|---|---|---|---|---|
| Chapter intro video | `lessons.video_url` | `lessons.duration_seconds` | `videos/` | optional |
| Unit **lesson** video (`kind=lesson`) | `lesson_units.video_url` | `lesson_units.duration_seconds` | `unit-videos/` | optional |
| Unit **practice** video (`kind=practice`) | `lesson_units.practice_video_url` | `lesson_units.practice_duration_seconds` | `unit-practice-videos/` | optional |

- A unit can have a lesson video, a practice video, both, or neither.
- The old single unit video is the `lesson` kind (`video_url`), so existing videos need no migration.
- Migration `sql/056_unit_practice_video.sql` adds the practice columns. Run it first.

## 2b. Sub-topics (sections inside a unit)

A unit's text (`lesson_units.content`, Markdown) is what the app splits into **sub-topics**. They are the numbered, tap-to-expand cards inside a unit (History courses only).

- Sub-topics are **not stored**. `GET /api/units/:id` computes them on every request, in `splitIntoSections()` in `src/routes/units.routes.js`.
- A sub-topic starts at a heading line (a lone `**bold line**` or `### heading`) and runs until the next heading. A paragraph with no heading above it becomes its own sub-topic, titled from its first sentence.
- A sub-topic has no id of its own. It is identified only by its position (1, 2, 3 …) in the unit.

**Videos cannot attach to a sub-topic.** There is no column, table or endpoint for it. A video belongs to the **unit**, and the app shows it in the unit's "Videos" list, above the sub-topic cards. The two videos play for the whole unit:

| Video | Meant for | Where the student sees it |
|---|---|---|
| `lesson` | Teaches the whole unit, covering all its sub-topics | Unit screen, "Lesson" chip |
| `practice` | Worked practice for the unit | Unit screen, "Practice" chip |

So for the bot, the smallest thing a file maps to is a unit:

```
chapter (lessons row)            -> chapter intro video
  unit (lesson_units row)        -> lesson video + practice video
    sub-topic (computed section) -> no video of its own
```

If a source video covers one sub-topic only, there are two options:

1. **Merge** the sub-topic videos for a unit into one file (for example with `ffmpeg -f concat`) and upload that as the unit's `lesson` video. This needs no code change.
2. **Add per-sub-topic videos.** This is a new feature: sub-topics would need stable ids, for example a `unit_section_videos(unit_id, section_index, video_url, duration_seconds)` table, upload endpoints like the unit ones, and a player on each section card. Say so if you want it and I'll build it. Sub-topics identified by position break if the unit text is edited, so each video would need to be tied to the heading text or an id stored in the Markdown.

## 3. Storage

- Supabase Storage bucket: **`course-materials`** (public bucket).
- The database stores the **storage path**, not a URL, e.g. `unit-videos/<unitId>-<timestamp>.mp4`.
- The public URL is `${SUPABASE_URL}/storage/v1/object/public/course-materials/<path>`. The API adds the prefix when it returns data.
- Bucket size cap is 1.5 GB per file (`sql/041_video_upload_limit.sql`). The dashboard's global upload limit (Storage → Settings) must also allow it.
- Allowed content types: `video/mp4`, `video/quicktime` (.mov), `video/webm`, `video/x-m4v`, `video/x-matroska` (.mkv).

Path convention (the API enforces it when attaching):

| Slot | Path |
|---|---|
| Chapter | `videos/<lessonId>-<Date.now()>.<ext>` |
| Unit lesson video | `unit-videos/<unitId>-<Date.now()>.<ext>` |
| Unit practice video | `unit-practice-videos/<unitId>-<Date.now()>.<ext>` |

## 4. Upload flow (3 steps, per video)

The file goes **straight from the bot to Supabase Storage** through a signed upload URL. It never streams through the backend.

1. **Ask for an upload URL.** `POST /api/units/:unitId/video/upload-url` with `{ "content_type": "video/mp4", "kind": "lesson" | "practice" }`. The response has `path`, `token`, `upload_url` and `public_url`.
2. **Upload the file** to `upload_url` with `PUT`, sending the file bytes as the body and `Content-Type` set to the video's type.
3. **Attach it.** `POST /api/units/:unitId/video` with `{ "path": "<path from step 1>", "kind": "lesson" | "practice", "duration_seconds": 312 }`. The backend checks the object exists in storage, writes the path to the column, and deletes the unit's previous video file if it was replaced.

For a chapter intro video use the same three steps on `/api/lessons/:lessonId/video/upload-url` and `/api/lessons/:lessonId/video` (no `kind`).

Remove a video with `DELETE /api/units/:unitId/video?kind=lesson|practice`. For a chapter, use `DELETE /api/lessons/:lessonId/video`.

## 5. Auth

Every write endpoint above needs a **teacher / admin / super_admin** JWT from the backend (not a Supabase key):

```
POST /api/auth/login   { email, password }   → data.token
Authorization: Bearer <token>
```

A teacher can only touch videos in their own courses. Admin and super_admin can touch any. Tokens expire (default 7 days, `JWT_EXPIRE`), so the bot should log in at the start of each run.

Writing straight to the Supabase Storage API with a service-role key also works for the upload itself, but the database column still has to be set. Going through the three steps above keeps the path convention, the ownership check and the cleanup of replaced files.

## 6. Finding the ids to map files to

```
GET /api/courses                       → courses (id, title)
GET /api/lessons/course/:courseId      → chapters (id, title, order_number)
GET /api/units?lesson_id=:lessonId     → units (id, title, order_number, video_url, practice_video_url, …)
```

`order_number` starts at 1 within its parent and gives the order students see.

## 7. Suggested local folder layout for the bot

Use names the bot can parse, so no id has to be typed by hand:

```
videos/
  <course>/                        e.g. history-grade-12
    ch01/                          chapter order_number, zero-padded
                                   (no per-sub-topic files: one lesson + one practice video per unit)
      chapter.mp4                  → chapter intro video   (optional)
      u01.lesson.mp4               → unit 1, lesson video  (optional)
      u01.practice.mp4             → unit 1, practice video (optional)
      u02.lesson.mp4
      u02.practice.mp4
    ch02/
      …
```

Mapping rules for the bot:

1. Resolve the course by folder name (keep a small `course-folder → courseId` map or match on title).
2. `chNN` → the chapter whose `order_number == NN`.
3. `uNN.<kind>.<ext>` → the unit whose `order_number == NN` in that chapter, with `kind` = `lesson` or `practice`.
4. `chapter.<ext>` → the chapter intro video.
5. Missing files are fine. Every slot is optional, so skip it.
6. Skip files already attached. Compare on the unit's `video_url` / `practice_video_url`, or keep a local hash → path log. This avoids re-uploading gigabytes on every run.
7. Get `duration_seconds` with `ffprobe -v error -show_entries format=duration -of csv=p=0 <file>` (round to an integer).

## 8. Pseudocode

```js
const token = await login();                              // POST /api/auth/login
for (const ch of await getChapters(courseId)) {
  const dir = `videos/${course}/ch${pad(ch.order_number)}`;
  const units = await getUnits(ch.id);                    // GET /api/units?lesson_id=
  for (const u of units) {
    for (const kind of ['lesson', 'practice']) {
      const file = `${dir}/u${pad(u.order_number)}.${kind}.mp4`;
      if (!exists(file)) continue;
      const { path, upload_url } = await post(`/api/units/${u.id}/video/upload-url`,
        { content_type: 'video/mp4', kind });
      await put(upload_url, readStream(file), { 'Content-Type': 'video/mp4' });
      await post(`/api/units/${u.id}/video`,
        { path, kind, duration_seconds: await probeSeconds(file) });
    }
  }
}
```

## 9. What the apps do with it

- **Mobile**: a unit shows a "Videos" list with a "Lesson" and a "Practice" chip. Only the slots that have a video appear.
- **Web (teacher)**: the unit editor has two upload slots, lesson and practice.
- The API returns the **public URL** (not the raw path) for `video_url` and `practice_video_url` on unit list/detail and on the PUT response.
- Videos on locked units are hidden from students. The API returns `null` until the unit is unlocked.
