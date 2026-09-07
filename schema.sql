--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: achievements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.achievements (
    id uuid NOT NULL,
    student_id uuid NOT NULL,
    badge_code text NOT NULL,
    earned_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: assignment_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assignment_submissions (
    id uuid NOT NULL,
    assignment_id uuid NOT NULL,
    student_id uuid NOT NULL,
    submission_text text,
    file_url character varying(500),
    grade integer,
    feedback text,
    submitted_at timestamp without time zone DEFAULT now(),
    graded_at timestamp without time zone
);


--
-- Name: assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assignments (
    id uuid NOT NULL,
    course_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    due_date timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: badges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.badges (
    code text NOT NULL,
    label text NOT NULL,
    description text
);


--
-- Name: course_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.course_enrollments (
    id uuid NOT NULL,
    course_id uuid NOT NULL,
    student_id uuid NOT NULL,
    enrolled_at timestamp without time zone DEFAULT now(),
    paid boolean DEFAULT false NOT NULL,
    paid_at timestamp without time zone,
    paid_until date,
    payment_note text
);


--
-- Name: courses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.courses (
    id uuid NOT NULL,
    teacher_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    category character varying(100),
    created_at timestamp without time zone DEFAULT now(),
    color character varying(7) DEFAULT '#667eea'::character varying,
    icon character varying(100) DEFAULT '📚'::character varying,
    cover_image character varying(500),
    code character varying(50),
    is_free boolean DEFAULT false NOT NULL,
    live_enabled boolean DEFAULT true NOT NULL
);


--
-- Name: daily_quiz_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_quiz_attempts (
    id uuid NOT NULL,
    student_id uuid NOT NULL,
    quiz_date date DEFAULT CURRENT_DATE NOT NULL,
    question_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    answers jsonb,
    correct_count integer,
    total_count integer,
    score integer,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: lesson_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lesson_attachments (
    id uuid NOT NULL,
    lesson_id uuid NOT NULL,
    file_url text NOT NULL,
    title text,
    size_bytes bigint,
    content_type text,
    order_number integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lesson_completions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lesson_completions (
    id uuid NOT NULL,
    lesson_id uuid NOT NULL,
    student_id uuid NOT NULL,
    completed_at timestamp without time zone DEFAULT now()
);


--
-- Name: lesson_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lesson_units (
    id uuid NOT NULL,
    lesson_id uuid NOT NULL,
    title text NOT NULL,
    content text,
    order_number integer DEFAULT 0 NOT NULL,
    is_free boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lessons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lessons (
    id uuid NOT NULL,
    course_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    file_url character varying(500),
    file_type character varying(50),
    text_content text,
    order_number integer,
    created_at timestamp without time zone DEFAULT now(),
    total_pages integer DEFAULT 1,
    start_page integer DEFAULT 1,
    end_page integer DEFAULT 1,
    is_free boolean DEFAULT false NOT NULL,
    duration_seconds integer,
    video_url text,
    thumbnail_url text
);


--
-- Name: live_class_hand_raises; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.live_class_hand_raises (
    live_class_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: live_class_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.live_class_participants (
    id uuid NOT NULL,
    live_class_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role character varying(50),
    joined_at timestamp without time zone DEFAULT now(),
    left_at timestamp without time zone
);


--
-- Name: live_classes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.live_classes (
    id uuid NOT NULL,
    course_id uuid NOT NULL,
    teacher_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    channel_name character varying(255) NOT NULL,
    status character varying(50) DEFAULT 'scheduled'::character varying,
    scheduled_at timestamp without time zone,
    started_at timestamp without time zone,
    ended_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: path_chest_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.path_chest_claims (
    student_id uuid NOT NULL,
    course_id uuid NOT NULL,
    chest_index integer NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: quiz_questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quiz_questions (
    id uuid NOT NULL,
    quiz_id uuid NOT NULL,
    question text NOT NULL,
    options jsonb NOT NULL,
    correct_answer text NOT NULL,
    question_type character varying(50) DEFAULT 'multiple_choice'::character varying,
    order_number integer,
    created_at timestamp without time zone DEFAULT now(),
    explanation text,
    difficulty text
);


--
-- Name: quiz_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quiz_submissions (
    id uuid NOT NULL,
    quiz_id uuid NOT NULL,
    student_id uuid NOT NULL,
    answers jsonb NOT NULL,
    score integer,
    passed boolean,
    submitted_at timestamp without time zone DEFAULT now()
);


--
-- Name: quizzes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quizzes (
    id uuid NOT NULL,
    course_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    pass_percentage integer DEFAULT 70,
    time_limit integer,
    created_at timestamp without time zone DEFAULT now(),
    lesson_id uuid,
    status text DEFAULT 'draft'::text,
    updated_at timestamp with time zone DEFAULT now(),
    unit_id uuid,
    CONSTRAINT quizzes_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))
);


--
-- Name: unit_completions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unit_completions (
    id uuid NOT NULL,
    unit_id uuid NOT NULL,
    student_id uuid NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    email character varying(255),
    password character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    role character varying(50) NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    avatar_url text,
    phone text,
    xp integer DEFAULT 0 NOT NULL,
    bio text,
    is_active boolean DEFAULT true NOT NULL,
    paid_until date,
    last_paid_at timestamp without time zone,
    deactivated_at timestamp with time zone,
    deletion_requested_at timestamp with time zone,
    deletion_scheduled_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: xp_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.xp_events (
    id uuid NOT NULL,
    student_id uuid NOT NULL,
    amount integer NOT NULL,
    reason text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: achievements achievements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.achievements
    ADD CONSTRAINT achievements_pkey PRIMARY KEY (id);


--
-- Name: achievements achievements_student_id_badge_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.achievements
    ADD CONSTRAINT achievements_student_id_badge_code_key UNIQUE (student_id, badge_code);


--
-- Name: assignment_submissions assignment_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_submissions
    ADD CONSTRAINT assignment_submissions_pkey PRIMARY KEY (id);


--
-- Name: assignments assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_pkey PRIMARY KEY (id);


--
-- Name: badges badges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.badges
    ADD CONSTRAINT badges_pkey PRIMARY KEY (code);


--
-- Name: course_enrollments course_enrollments_course_id_student_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_enrollments
    ADD CONSTRAINT course_enrollments_course_id_student_id_key UNIQUE (course_id, student_id);


--
-- Name: course_enrollments course_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_enrollments
    ADD CONSTRAINT course_enrollments_pkey PRIMARY KEY (id);


--
-- Name: course_enrollments course_enrollments_unique_student_course; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_enrollments
    ADD CONSTRAINT course_enrollments_unique_student_course UNIQUE (course_id, student_id);


--
-- Name: courses courses_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.courses
    ADD CONSTRAINT courses_code_key UNIQUE (code);


--
-- Name: courses courses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.courses
    ADD CONSTRAINT courses_pkey PRIMARY KEY (id);


--
-- Name: daily_quiz_attempts daily_quiz_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_quiz_attempts
    ADD CONSTRAINT daily_quiz_attempts_pkey PRIMARY KEY (id);


--
-- Name: daily_quiz_attempts daily_quiz_attempts_student_id_quiz_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_quiz_attempts
    ADD CONSTRAINT daily_quiz_attempts_student_id_quiz_date_key UNIQUE (student_id, quiz_date);


--
-- Name: lesson_attachments lesson_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_attachments
    ADD CONSTRAINT lesson_attachments_pkey PRIMARY KEY (id);


--
-- Name: lesson_completions lesson_completions_lesson_id_student_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_completions
    ADD CONSTRAINT lesson_completions_lesson_id_student_id_key UNIQUE (lesson_id, student_id);


--
-- Name: lesson_completions lesson_completions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_completions
    ADD CONSTRAINT lesson_completions_pkey PRIMARY KEY (id);


--
-- Name: lesson_completions lesson_completions_unique_student_lesson; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_completions
    ADD CONSTRAINT lesson_completions_unique_student_lesson UNIQUE (lesson_id, student_id);


--
-- Name: lesson_units lesson_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_units
    ADD CONSTRAINT lesson_units_pkey PRIMARY KEY (id);


--
-- Name: lessons lessons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lessons
    ADD CONSTRAINT lessons_pkey PRIMARY KEY (id);


--
-- Name: live_class_hand_raises live_class_hand_raises_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_class_hand_raises
    ADD CONSTRAINT live_class_hand_raises_pkey PRIMARY KEY (live_class_id, user_id);


--
-- Name: live_class_participants live_class_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_class_participants
    ADD CONSTRAINT live_class_participants_pkey PRIMARY KEY (id);


--
-- Name: live_classes live_classes_channel_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_classes
    ADD CONSTRAINT live_classes_channel_name_key UNIQUE (channel_name);


--
-- Name: live_classes live_classes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_classes
    ADD CONSTRAINT live_classes_pkey PRIMARY KEY (id);


--
-- Name: path_chest_claims path_chest_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.path_chest_claims
    ADD CONSTRAINT path_chest_claims_pkey PRIMARY KEY (student_id, course_id, chest_index);


--
-- Name: quiz_questions quiz_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_questions
    ADD CONSTRAINT quiz_questions_pkey PRIMARY KEY (id);


--
-- Name: quiz_submissions quiz_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_submissions
    ADD CONSTRAINT quiz_submissions_pkey PRIMARY KEY (id);


--
-- Name: quizzes quizzes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quizzes
    ADD CONSTRAINT quizzes_pkey PRIMARY KEY (id);


--
-- Name: unit_completions unit_completions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_completions
    ADD CONSTRAINT unit_completions_pkey PRIMARY KEY (id);


--
-- Name: unit_completions unit_completions_unit_id_student_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_completions
    ADD CONSTRAINT unit_completions_unit_id_student_id_key UNIQUE (unit_id, student_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: xp_events xp_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xp_events
    ADD CONSTRAINT xp_events_pkey PRIMARY KEY (id);


--
-- Name: achievements_student_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX achievements_student_idx ON public.achievements USING btree (student_id);


--
-- Name: course_enrollments_paid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX course_enrollments_paid_idx ON public.course_enrollments USING btree (student_id, paid);


--
-- Name: idx_quizzes_lesson_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quizzes_lesson_id ON public.quizzes USING btree (lesson_id);


--
-- Name: lesson_attachments_lesson_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lesson_attachments_lesson_idx ON public.lesson_attachments USING btree (lesson_id);


--
-- Name: lesson_units_lesson_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lesson_units_lesson_idx ON public.lesson_units USING btree (lesson_id, order_number);


--
-- Name: lesson_units_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lesson_units_search_idx ON public.lesson_units USING gin ((((COALESCE(title, ''::text) || ' '::text) || COALESCE(content, ''::text))) public.gin_trgm_ops);


--
-- Name: live_class_hand_raises_class_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX live_class_hand_raises_class_status_idx ON public.live_class_hand_raises USING btree (live_class_id, status);


--
-- Name: live_class_participants_class_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX live_class_participants_class_idx ON public.live_class_participants USING btree (live_class_id);


--
-- Name: live_class_participants_one_open_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX live_class_participants_one_open_per_user ON public.live_class_participants USING btree (live_class_id, user_id) WHERE (left_at IS NULL);


--
-- Name: live_classes_course_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX live_classes_course_id_idx ON public.live_classes USING btree (course_id);


--
-- Name: live_classes_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX live_classes_status_idx ON public.live_classes USING btree (status);


--
-- Name: quizzes_unit_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quizzes_unit_id_idx ON public.quizzes USING btree (unit_id);


--
-- Name: unit_completions_student_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX unit_completions_student_idx ON public.unit_completions USING btree (student_id);


--
-- Name: users_deletion_scheduled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_deletion_scheduled_idx ON public.users USING btree (deletion_scheduled_at) WHERE (deletion_scheduled_at IS NOT NULL);


--
-- Name: xp_events_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX xp_events_created_idx ON public.xp_events USING btree (created_at);


--
-- Name: xp_events_student_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX xp_events_student_created_idx ON public.xp_events USING btree (student_id, created_at);


--
-- Name: quizzes set_quizzes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_quizzes_updated_at BEFORE UPDATE ON public.quizzes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: achievements achievements_badge_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.achievements
    ADD CONSTRAINT achievements_badge_code_fkey FOREIGN KEY (badge_code) REFERENCES public.badges(code) ON DELETE CASCADE;


--
-- Name: achievements achievements_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.achievements
    ADD CONSTRAINT achievements_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: assignment_submissions assignment_submissions_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_submissions
    ADD CONSTRAINT assignment_submissions_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.assignments(id) ON DELETE CASCADE;


--
-- Name: assignment_submissions assignment_submissions_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_submissions
    ADD CONSTRAINT assignment_submissions_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: assignments assignments_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT assignments_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;


--
-- Name: course_enrollments course_enrollments_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_enrollments
    ADD CONSTRAINT course_enrollments_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;


--
-- Name: course_enrollments course_enrollments_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_enrollments
    ADD CONSTRAINT course_enrollments_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: courses courses_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.courses
    ADD CONSTRAINT courses_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: daily_quiz_attempts daily_quiz_attempts_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_quiz_attempts
    ADD CONSTRAINT daily_quiz_attempts_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: lesson_attachments lesson_attachments_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_attachments
    ADD CONSTRAINT lesson_attachments_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lessons(id) ON DELETE CASCADE;


--
-- Name: lesson_completions lesson_completions_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_completions
    ADD CONSTRAINT lesson_completions_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lessons(id) ON DELETE CASCADE;


--
-- Name: lesson_completions lesson_completions_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_completions
    ADD CONSTRAINT lesson_completions_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: lesson_units lesson_units_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_units
    ADD CONSTRAINT lesson_units_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lessons(id) ON DELETE CASCADE;


--
-- Name: lessons lessons_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lessons
    ADD CONSTRAINT lessons_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;


--
-- Name: live_class_hand_raises live_class_hand_raises_live_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_class_hand_raises
    ADD CONSTRAINT live_class_hand_raises_live_class_id_fkey FOREIGN KEY (live_class_id) REFERENCES public.live_classes(id) ON DELETE CASCADE;


--
-- Name: live_class_hand_raises live_class_hand_raises_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_class_hand_raises
    ADD CONSTRAINT live_class_hand_raises_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: live_class_participants live_class_participants_live_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_class_participants
    ADD CONSTRAINT live_class_participants_live_class_id_fkey FOREIGN KEY (live_class_id) REFERENCES public.live_classes(id) ON DELETE CASCADE;


--
-- Name: live_class_participants live_class_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_class_participants
    ADD CONSTRAINT live_class_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: live_classes live_classes_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_classes
    ADD CONSTRAINT live_classes_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;


--
-- Name: live_classes live_classes_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_classes
    ADD CONSTRAINT live_classes_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: path_chest_claims path_chest_claims_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.path_chest_claims
    ADD CONSTRAINT path_chest_claims_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;


--
-- Name: path_chest_claims path_chest_claims_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.path_chest_claims
    ADD CONSTRAINT path_chest_claims_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: quiz_questions quiz_questions_quiz_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_questions
    ADD CONSTRAINT quiz_questions_quiz_id_fkey FOREIGN KEY (quiz_id) REFERENCES public.quizzes(id) ON DELETE CASCADE;


--
-- Name: quiz_submissions quiz_submissions_quiz_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_submissions
    ADD CONSTRAINT quiz_submissions_quiz_id_fkey FOREIGN KEY (quiz_id) REFERENCES public.quizzes(id) ON DELETE CASCADE;


--
-- Name: quiz_submissions quiz_submissions_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quiz_submissions
    ADD CONSTRAINT quiz_submissions_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: quizzes quizzes_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quizzes
    ADD CONSTRAINT quizzes_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id) ON DELETE CASCADE;


--
-- Name: quizzes quizzes_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quizzes
    ADD CONSTRAINT quizzes_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.lessons(id) ON DELETE CASCADE;


--
-- Name: quizzes quizzes_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quizzes
    ADD CONSTRAINT quizzes_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.lesson_units(id) ON DELETE CASCADE;


--
-- Name: unit_completions unit_completions_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_completions
    ADD CONSTRAINT unit_completions_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: unit_completions unit_completions_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unit_completions
    ADD CONSTRAINT unit_completions_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.lesson_units(id) ON DELETE CASCADE;


--
-- Name: xp_events xp_events_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.xp_events
    ADD CONSTRAINT xp_events_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: lessons Allow authenticated delete on lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated delete on lessons" ON public.lessons FOR DELETE TO authenticated USING (true);


--
-- Name: quizzes Allow authenticated delete on quizzes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated delete on quizzes" ON public.quizzes FOR DELETE TO authenticated USING (true);


--
-- Name: lessons Allow authenticated insert on lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated insert on lessons" ON public.lessons FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: quizzes Allow authenticated insert on quizzes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated insert on quizzes" ON public.quizzes FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: lessons Allow authenticated read access on lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated read access on lessons" ON public.lessons FOR SELECT TO authenticated USING (true);


--
-- Name: quizzes Allow authenticated read on quizzes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated read on quizzes" ON public.quizzes FOR SELECT TO authenticated USING (true);


--
-- Name: lessons Allow authenticated update on lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated update on lessons" ON public.lessons FOR UPDATE TO authenticated USING (true);


--
-- Name: quizzes Allow authenticated update on quizzes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated update on quizzes" ON public.quizzes FOR UPDATE TO authenticated USING (true);


--
-- Name: live_classes Allow authenticated users to create live classes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated users to create live classes" ON public.live_classes FOR INSERT TO authenticated, anon WITH CHECK (true);


--
-- Name: daily_quiz_attempts Allow authenticated users to read and insert attempts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated users to read and insert attempts" ON public.daily_quiz_attempts TO authenticated USING (true) WITH CHECK (true);


--
-- Name: lessons Allow authenticated users to read lessons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated users to read lessons" ON public.lessons FOR SELECT TO authenticated USING (true);


--
-- Name: users Allow public signup; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow public signup" ON public.users FOR INSERT TO authenticated, anon WITH CHECK (true);


--
-- Name: users Allow reading user profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow reading user profiles" ON public.users FOR SELECT TO authenticated, anon USING (true);


--
-- Name: users Allow users to update own record; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow users to update own record" ON public.users FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: live_classes Allow users to view live classes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow users to view live classes" ON public.live_classes FOR SELECT TO authenticated, anon USING (true);


--
-- Name: courses Anyone can view courses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view courses" ON public.courses FOR SELECT TO authenticated, anon USING (true);


--
-- Name: courses Teachers can create courses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can create courses" ON public.courses FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: courses Teachers can delete their own courses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can delete their own courses" ON public.courses FOR DELETE TO authenticated USING ((teacher_id = auth.uid()));


--
-- Name: live_classes Teachers can delete their own live classes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can delete their own live classes" ON public.live_classes FOR DELETE TO authenticated USING ((teacher_id = auth.uid()));


--
-- Name: courses Teachers can update their own courses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can update their own courses" ON public.courses FOR UPDATE TO authenticated USING ((teacher_id = auth.uid()));


--
-- Name: live_classes Teachers can update their own live classes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers can update their own live classes" ON public.live_classes FOR UPDATE TO authenticated USING ((teacher_id = auth.uid()));


--
-- Name: achievements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.achievements ENABLE ROW LEVEL SECURITY;

--
-- Name: assignment_submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assignment_submissions ENABLE ROW LEVEL SECURITY;

--
-- Name: assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: badges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.badges ENABLE ROW LEVEL SECURITY;

--
-- Name: course_enrollments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.course_enrollments ENABLE ROW LEVEL SECURITY;

--
-- Name: courses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_quiz_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_quiz_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: lesson_attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lesson_attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: lesson_completions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lesson_completions ENABLE ROW LEVEL SECURITY;

--
-- Name: lesson_units; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lesson_units ENABLE ROW LEVEL SECURITY;

--
-- Name: lessons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;

--
-- Name: live_class_participants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.live_class_participants ENABLE ROW LEVEL SECURITY;

--
-- Name: live_classes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.live_classes ENABLE ROW LEVEL SECURITY;

--
-- Name: path_chest_claims; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.path_chest_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: quiz_questions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quiz_questions ENABLE ROW LEVEL SECURITY;

--
-- Name: quiz_submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quiz_submissions ENABLE ROW LEVEL SECURITY;

--
-- Name: quizzes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quizzes ENABLE ROW LEVEL SECURITY;

--
-- Name: unit_completions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.unit_completions ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: xp_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.xp_events ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


