import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { requireReason } from "./admin-suspension.service";

/**
 * Internal staff notes + account timeline for a User or Vendor
 * (handbook 4.2 L180). Notes are never exposed to the subject.
 */

type NoteEntity = "User" | "Vendor";

async function resolveActors(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } });
  return new Map(users.map((u) => [u.id, u.name || u.email]));
}

async function assertEntityExists(entityType: NoteEntity, id: string): Promise<void> {
  const found = entityType === "User"
    ? await prisma.user.findUnique({ where: { id }, select: { id: true } })
    : await prisma.vendor.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw new AppError(`${entityType} not found`, 404);
}

export function listNotes(entityType: NoteEntity) {
  return async (request: Request, response: Response): Promise<void> => {
    const id = String(request.params.id);
    await assertEntityExists(entityType, id);
    const notes = await prisma.adminNote.findMany({
      where: { entityType, entityId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const actors = await resolveActors(notes.map((n) => n.authorId));
    response.status(200).json({
      notes: notes.map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt, authorId: n.authorId, authorName: actors.get(n.authorId) ?? "Unknown admin" })),
    });
  };
}

export function addNote(entityType: NoteEntity) {
  return async (request: Request, response: Response): Promise<void> => {
    const adminId = request.user?.id;
    if (!adminId) throw new AppError("Unauthorized", 401);
    const id = String(request.params.id);
    await assertEntityExists(entityType, id);
    const body = requireReason(request.body?.body, "note");
    const note = await prisma.adminNote.create({ data: { entityType, entityId: id, authorId: adminId, body } });
    await recordAudit({
      actorId: adminId,
      action: `${entityType.toLowerCase()}.note_added`,
      entityType,
      entityId: id,
      reason: "Internal note added",
      afterState: { noteId: note.id },
      request,
    });
    response.status(201).json({ note: { id: note.id, body: note.body, createdAt: note.createdAt, authorId: adminId } });
  };
}

export function accountTimeline(entityType: NoteEntity) {
  return async (request: Request, response: Response): Promise<void> => {
    const id = String(request.params.id);
    await assertEntityExists(entityType, id);
    const rows = await prisma.auditLog.findMany({
      where: { entityType, entityId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, actorId: true, action: true, reason: true, beforeState: true, afterState: true, createdAt: true },
    });
    const actors = await resolveActors(rows.map((r) => r.actorId));
    response.status(200).json({
      events: rows.map((r) => ({
        id: r.id,
        action: r.action,
        reason: r.reason,
        beforeState: r.beforeState,
        afterState: r.afterState,
        createdAt: r.createdAt,
        actorName: actors.get(r.actorId) ?? (r.actorId === "system" ? "System" : "Unknown admin"),
      })),
    });
  };
}
