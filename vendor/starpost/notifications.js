export const DEFAULT_NOTIFICATION_SETTINGS = {
    squareMode: 'digest',
    feedMode: 'digest',
    digestIntervalMs: 300000
};
const MAX_PENDING_ITEMS = 500;
const MAX_DIGEST_ITEMS = 20;
const text = (value, limit)=>typeof value === 'string' ? value.slice(0, limit) : '';
const categoryOf = (type)=>[
        'square.bot',
        'square.group'
    ].includes(type) ? 'square' : [
        'post.published',
        'post.deleted',
        'post.comment'
    ].includes(type) ? 'feed' : null;
export function notificationSettings(settings) {
    const interval = settings?.digestIntervalMs;
    return {
        squareMode: settings?.squareMode === 'realtime' || settings?.squareMode === 'manual' ? settings.squareMode : 'digest',
        feedMode: settings?.feedMode === 'realtime' ? 'realtime' : 'digest',
        digestIntervalMs: typeof interval === 'number' && Number.isInteger(interval) && interval >= 1000 && interval <= 86400000 ? interval : DEFAULT_NOTIFICATION_SETTINGS.digestIntervalMs
    };
}
export class NotificationDigest {
    firstQueuedAt = null;
    items = new Map();
    overflowEvents = {
        square: 0,
        feed: 0
    };
    restore(value) {
        if (!value || typeof value !== 'object') return;
        const state = value;
        if (!Array.isArray(state.items)) return;
        this.items.clear();
        for (const row of state.items.slice(0, MAX_PENDING_ITEMS)){
            if (!row || ![
                'square',
                'feed'
            ].includes(row.category) || typeof row.id !== 'string' || categoryOf(row.type) !== row.category) continue;
            const item = {
                category: row.category,
                id: text(row.id, 100),
                type: row.type,
                at: text(row.at, 50),
                author: text(row.author, 100),
                preview: text(row.preview, 160),
                truncated: row.truncated === true,
                counts: {}
            };
            for (const [type, count] of Object.entries(row.counts ?? {})){
                if (categoryOf(type) === row.category && Number.isSafeInteger(count) && count > 0) item.counts[type] = count;
            }
            for (const key of [
                'kind',
                'target',
                'nickname',
                'groupName',
                'commentId'
            ])if (typeof row[key] === 'string') item[key] = text(row[key], 100);
            this.items.set(`${item.category}:${item.id}`, item);
        }
        for (const category of [
            'square',
            'feed'
        ])this.overflowEvents[category] = Number.isSafeInteger(state.overflowEvents?.[category]) && state.overflowEvents[category] > 0 ? state.overflowEvents[category] : 0;
        this.firstQueuedAt = this.items.size || this.overflowEvents.square || this.overflowEvents.feed ? Number.isSafeInteger(state.firstQueuedAt) && state.firstQueuedAt >= 0 ? state.firstQueuedAt : 0 : null;
    }
    state() {
        return {
            firstQueuedAt: this.firstQueuedAt,
            items: [
                ...this.items.values()
            ].map((item)=>({
                    ...item,
                    counts: {
                        ...item.counts
                    }
                })),
            overflowEvents: {
                ...this.overflowEvents
            }
        };
    }
    enqueue(event, settings, now) {
        const category = categoryOf(event.type);
        if (!category) return false;
        const mode = category === 'square' ? settings.squareMode : settings.feedMode;
        if (mode === 'realtime') return false;
        if (mode === 'manual') return true;
        const data = event.data, id = category === 'square' ? data?.id : data?.postId;
        if (typeof id !== 'string' || !id || id.length > 100) return false;
        this.firstQueuedAt ??= now;
        const key = `${category}:${id}`, previous = this.items.get(key);
        if (!previous && this.items.size >= MAX_PENDING_ITEMS) {
            this.overflowEvents[category]++;
            return true;
        }
        const body = event.type === 'post.comment' ? data.comment?.text : event.type === 'post.deleted' ? '' : data.text;
        const item = {
            category,
            id,
            type: event.type,
            at: event.at,
            author: text(event.type === 'post.comment' ? data.comment?.author : data.author, 100),
            counts: {
                ...previous?.counts ?? {},
                [event.type]: (previous?.counts[event.type] ?? 0) + 1
            },
            preview: text(body, 160),
            truncated: typeof body === 'string' && body.length > 160
        };
        if (category === 'square') {
            item.kind = text(data.kind, 20);
            item.target = text(data.target, 100);
            item.nickname = text(data.nickname, 100);
            item.groupName = text(data.groupName, 100);
        }
        if (event.type === 'post.comment') item.commentId = text(data.comment?.id, 100);
        this.items.set(key, item);
        return true;
    }
    removeSquare(ids) {
        for (const id of ids)this.items.delete(`square:${id}`);
        this.resetEmpty();
    }
    applySettings(settings) {
        if (settings.squareMode === 'manual') {
            for (const [key, item] of this.items)if (item.category === 'square') this.items.delete(key);
            this.overflowEvents.square = 0;
            this.resetEmpty();
        }
    }
    dueIn(now, settings) {
        if (this.firstQueuedAt === null) return Infinity;
        if (this.overflowEvents.square && settings.squareMode === 'realtime' || this.overflowEvents.feed && settings.feedMode === 'realtime') return 0;
        if ([
            ...this.items.values()
        ].some((item)=>(item.category === 'square' ? settings.squareMode : settings.feedMode) === 'realtime')) return 0;
        return Math.max(0, this.firstQueuedAt + settings.digestIntervalMs - now);
    }
    build() {
        const all = [
            ...this.items.values()
        ].sort((a, b)=>b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
        const overflowEvents = this.overflowEvents.square + this.overflowEvents.feed;
        const events = all.reduce((sum, item)=>sum + Object.values(item.counts).reduce((n, count)=>n + count, 0), overflowEvents);
        return {
            events,
            items: all.slice(0, MAX_DIGEST_ITEMS),
            omittedItems: Math.max(0, all.length - MAX_DIGEST_ITEMS),
            overflowEvents
        };
    }
    clear() {
        this.items.clear();
        this.overflowEvents = {
            square: 0,
            feed: 0
        };
        this.firstQueuedAt = null;
    }
    resetEmpty() {
        if (!this.items.size && !this.overflowEvents.square && !this.overflowEvents.feed) this.firstQueuedAt = null;
    }
}
