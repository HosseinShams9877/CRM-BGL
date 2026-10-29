'use client';

import React, { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Search, Plus, Building2, MapPin, Phone, Contact2, Brain, Handshake,
} from 'lucide-react';
import {
  Center, CenterContact,
} from './types';
import { AddContactDialog } from './add-contact-dialog';
import { PersonalityDialog } from './personality-dialog';
// v2.35.1 (round 61) — keyboard-layout auto-fix (client-side filter twins)
import { searchVariants } from '@/lib/keyboard-layout';

// ==================== CONTACTS TAB ====================
export function ContactsTab({ centers, onChanged, focusPersonId }: { centers: Center[]; onChanged: () => void; focusPersonId?: string }) {
  const [search, setSearch] = useState('');
  // v2.34.0 — deep-link focus: adjust DURING render (no effect — the
  // set-state-in-effect rule); the ring fades after 5s via timer ref.
  const [ringId, setRingId] = useState<string | null>(null);
  const [prevFocus, setPrevFocus] = useState<string | undefined>(undefined);
  // adjust-during-render: derive the ring from the incoming focus (no effect)
  if (focusPersonId !== prevFocus) {
    setPrevFocus(focusPersonId);
    setRingId(focusPersonId ?? null);
  }
  // fade-out timer — setState lives in the async timer callback (allowed)
  React.useEffect(() => {
    if (!ringId) return;
    const t = setTimeout(() => setRingId(null), 5000);
    return () => clearTimeout(t);
  }, [ringId]);
  const [filterCity, setFilterCity] = useState('all');
  const [filterAgent, setFilterAgent] = useState<'all' | 'agents'>('all');
  const [profileContact, setProfileContact] = useState<(CenterContact & { centerName?: string }) | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const allContacts = useMemo(() => {
    return centers.flatMap(c => c.contacts.map(ct => ({
      ...ct,
      centerName: c.name,
      centerId: c.id,
      city: c.city,
      lastContactDate: c.lastFollowup,
      totalCalls: c.orderCount,
    })));
  }, [centers]);

  const cities = useMemo(() => [...new Set(allContacts.map(c => c.city))], [allContacts]);

  const filtered = useMemo(() => {
    return allContacts.filter(c => {
      if (focusPersonId && ringId === focusPersonId) {
        // focus mode: show only the focused person until the ring fades
        if (c.id !== focusPersonId) return false;
      } else if (search.trim()) {
        // v2.35.1 (round 61) — Latin-typed queries also match their Persian-
        // layout twins («Hrhd» → «آقای»); mobile/digits via the raw variant.
        const qs = searchVariants(search).map((v) => v.toLowerCase());
        if (!qs.some((v) => c.fullName.includes(v) || c.centerName.includes(v) || c.role.includes(v) || c.mobile.includes(v))) return false;
      }
      if (filterCity !== 'all' && c.city !== filterCity) return false;
      if (filterAgent === 'agents' && !c.isAgent) return false;
      return true;
    });
  }, [allContacts, search, filterCity, filterAgent, focusPersonId, ringId]);

  const openProfile = (contact: CenterContact & { centerName?: string }) => {
    setProfileContact(contact);
    setShowProfile(true);
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو نام، مرکز، نقش..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" />
          </div>
          <select value={filterCity} onChange={(e) => setFilterCity(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
            <option value="all">همه شهرها</option>
            {cities.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button
            onClick={() => setFilterAgent(filterAgent === 'all' ? 'agents' : 'all')}
            className={`h-9 rounded-lg border px-3 text-xs font-medium transition-colors inline-flex items-center gap-1.5 shrink-0 ${filterAgent === 'agents' ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'}`}
          >
            <Handshake size={13} /> فقط رابطین
          </button>
          <Button onClick={() => setShowAdd(true)} className="h-9 gap-1.5 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
            <Plus size={13} /> شخص / رابط جدید
          </Button>
        </div>
      </div>

      {/* Contact list */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {filtered.length === 0 ? (
          <div className="col-span-full bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
            <Contact2 size={32} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">{filterAgent === 'agents' ? 'رابطی یافت نشد' : 'شخصی یافت نشد'}</p>
          </div>
        ) : (
          filtered.map((contact) => (
            <div
              key={contact.id}
              data-contact-id={contact.id}
              ref={ringId === contact.id ? (el) => { if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } : undefined}
              className={'bg-white rounded-xl border p-4 hover:shadow-sm transition-all animate-fade-in-up opacity-0 group ' + (ringId === contact.id ? 'border-teal-500 ring-4 ring-teal-200' : 'border-gray-100')}
            >
              <div className="flex items-start gap-3">
                <div className="w-12 h-12 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: contact.isAgent ? 'linear-gradient(135deg, #b45309, #7c2d12)' : 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                  {contact.fullName.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h4 className="text-sm font-bold text-gray-900 truncate">{contact.fullName}</h4>
                    {contact.isPrimary && <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-teal-100 text-teal-700 font-medium">اصلی</span>}
                    {contact.isAgent && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium inline-flex items-center gap-0.5">
                        <Handshake size={9} /> رابط
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-600 mb-0.5">{contact.role}</p>
                  <p className="text-[11px] text-gray-400 flex items-center gap-1"><Building2 size={10} /> {contact.centerName}</p>
                  <div className="flex items-center gap-3 mt-2 text-[11px] text-gray-500">
                    <span className="flex items-center gap-1" dir="ltr"><Phone size={10} /> {contact.mobile}</span>
                    <span className="flex items-center gap-1"><MapPin size={10} /> {contact.city}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => openProfile(contact)}
                    title="رگ خواب — ویژگی‌های شخصیتی"
                    className="w-8 h-8 rounded-lg bg-violet-50 text-violet-600 flex items-center justify-center hover:bg-violet-100 transition-colors">
                    <Brain size={14} />
                  </button>
                  <a href={`tel:${contact.mobile}`} className="w-8 h-8 rounded-lg bg-green-50 text-green-600 flex items-center justify-center hover:bg-green-100 transition-colors">
                    <Phone size={14} />
                  </a>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <PersonalityDialog contact={profileContact} open={showProfile} onOpenChange={setShowProfile} />
      <AddContactDialog centers={centers} open={showAdd} onOpenChange={setShowAdd} onDone={onChanged} />
    </div>
  );
}
