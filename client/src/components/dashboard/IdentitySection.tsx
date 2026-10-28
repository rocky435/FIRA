'use client';

import { useState } from 'react';
import { Button, Input, Select } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/contexts/AuthContext';
import { useIdentity } from '@/hooks/useIdentity';
import { isVenueOwner } from '@/lib/types';
import type { IdentityCheck, IdentityStatus } from '@/lib/api';

const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const GOV_ID_TYPES = [
    { value: 'aadhar', label: 'Aadhaar' },
    { value: 'pan', label: 'PAN Card' },
    { value: 'driving_license', label: 'Driving License' },
    { value: 'passport', label: 'Passport' },
    { value: 'voter_id', label: 'Voter ID' },
];

const STATUS: Record<IdentityStatus, { label: string; className: string }> = {
    none: { label: 'Not added', className: 'bg-white/10 text-gray-300' },
    pending: { label: 'Under review', className: 'bg-yellow-500/15 text-yellow-300' },
    verified: { label: 'Verified', className: 'bg-green-500/15 text-green-300' },
    rejected: { label: 'Not accepted', className: 'bg-red-500/15 text-red-300' },
};

export function IdentityStatusPill({ status }: { status: IdentityStatus }) {
    const s = STATUS[status] || STATUS.none;
    return <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${s.className}`}>{s.label}</span>;
}

type SubmitResult = { ok: true } | { ok: false; error: string; field?: string };

function PhotoField({ file, onChange, error, label }: { file: File | null; onChange: (f: File | null) => void; error?: string; label: string }) {
    return (
        <div>
            <p className="text-sm font-medium text-gray-200 mb-1.5">{label}</p>
            <label className={`flex items-center justify-center w-full rounded-xl border border-dashed px-4 py-5 cursor-pointer transition-colors ${error ? 'border-red-500/60' : 'border-white/20 hover:border-violet-500/60'}`}>
                <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => onChange(e.target.files?.[0] || null)}
                />
                <span className={`text-sm break-all ${file ? 'text-violet-300' : 'text-gray-400'}`}>
                    {file ? file.name : 'Choose a clear photo'}
                </span>
            </label>
            {error && <p role="alert" className="text-sm text-red-400 mt-1">{error}</p>}
            <p className="text-xs text-gray-500 mt-1">Only FIRA admins can see this photo.</p>
        </div>
    );
}

/** PAN number + PAN card photo. */
export function PanForm({ onSubmit, onCancel, submitLabel = 'Submit for review' }: {
    onSubmit: (panNumber: string, photo: File) => Promise<SubmitResult>;
    onCancel?: () => void;
    submitLabel?: string;
}) {
    const [number, setNumber] = useState('');
    const [photo, setPhoto] = useState<File | null>(null);
    const [errors, setErrors] = useState<{ number?: string; photo?: string; form?: string }>({});
    const [busy, setBusy] = useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const pan = number.trim().toUpperCase();
        const found: typeof errors = {};
        if (!PAN_PATTERN.test(pan)) found.number = 'Enter a valid PAN, like ABCDE1234F';
        if (!photo) found.photo = 'Add a photo of your PAN card';
        setErrors(found);
        if (found.number || found.photo || !photo) return;

        setBusy(true);
        const result = await onSubmit(pan, photo);
        setBusy(false);
        if (!result.ok) {
            setErrors(result.field === 'panNumber' ? { number: result.error }
                : result.field === 'panDocument' ? { photo: result.error }
                    : { form: result.error });
        }
    };

    return (
        <form onSubmit={submit} className="space-y-4">
            <Input
                label="PAN number"
                value={number}
                onChange={(e) => { setNumber(e.target.value.toUpperCase()); setErrors(p => ({ ...p, number: undefined })); }}
                placeholder="ABCDE1234F"
                maxLength={10}
                autoComplete="off"
                error={errors.number}
            />
            <PhotoField label="Photo of your PAN card" file={photo} error={errors.photo}
                onChange={(f) => { setPhoto(f); setErrors(p => ({ ...p, photo: undefined })); }} />
            {errors.form && <p role="alert" className="text-sm text-red-400">{errors.form}</p>}
            <div className="flex gap-3">
                <Button type="submit" variant="primary" size="sm" isLoading={busy} disabled={busy}>{submitLabel}</Button>
                {onCancel && <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>}
            </div>
        </form>
    );
}

/** Government ID type + number + photo. */
export function GovIdForm({ onSubmit, onCancel }: {
    onSubmit: (type: string, number: string, photo: File) => Promise<SubmitResult>;
    onCancel?: () => void;
}) {
    const [type, setType] = useState('aadhar');
    const [number, setNumber] = useState('');
    const [photo, setPhoto] = useState<File | null>(null);
    const [errors, setErrors] = useState<{ number?: string; photo?: string; form?: string }>({});
    const [busy, setBusy] = useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const found: typeof errors = {};
        if (number.trim().length < 4) found.number = 'Enter your ID number';
        if (!photo) found.photo = 'Add a photo of your ID';
        setErrors(found);
        if (found.number || found.photo || !photo) return;

        setBusy(true);
        const result = await onSubmit(type, number.trim(), photo);
        setBusy(false);
        if (!result.ok) {
            setErrors(result.field === 'govIdNumber' ? { number: result.error }
                : result.field === 'govIdDocument' ? { photo: result.error }
                    : { form: result.error });
        }
    };

    return (
        <form onSubmit={submit} className="space-y-4">
            <Select label="ID type" value={type} onChange={setType} options={GOV_ID_TYPES} />
            <Input
                label="ID number"
                value={number}
                onChange={(e) => { setNumber(e.target.value); setErrors(p => ({ ...p, number: undefined })); }}
                autoComplete="off"
                error={errors.number}
            />
            <PhotoField label="Photo of your ID" file={photo} error={errors.photo}
                onChange={(f) => { setPhoto(f); setErrors(p => ({ ...p, photo: undefined })); }} />
            {errors.form && <p role="alert" className="text-sm text-red-400">{errors.form}</p>}
            <div className="flex gap-3">
                <Button type="submit" variant="primary" size="sm" isLoading={busy} disabled={busy}>Submit for review</Button>
                {onCancel && <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>}
            </div>
        </form>
    );
}

function CheckCard({ title, purpose, check, typeLabel, renderForm }: {
    title: string;
    purpose: string;
    check: IdentityCheck;
    typeLabel?: string | null;
    renderForm: (close: () => void) => React.ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const canSubmit = check.status === 'none' || check.status === 'rejected';
    return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <h3 className="text-white font-medium">{title}</h3>
                <IdentityStatusPill status={check.status} />
            </div>
            <p className="text-sm text-gray-400">{purpose}</p>
            {check.numberLast4 && (
                <p className="text-sm text-gray-300 font-mono">
                    {typeLabel ? `${typeLabel} · ` : ''}ending {check.numberLast4}
                </p>
            )}
            {check.status === 'pending' && (
                <p className="text-sm text-gray-400">We&apos;ll notify you once it has been checked.</p>
            )}
            {check.status === 'rejected' && check.rejectionReason && (
                <p className="text-sm text-red-300">Reason: {check.rejectionReason}</p>
            )}
            {open ? renderForm(() => setOpen(false)) : (
                <Button variant={canSubmit ? 'primary' : 'ghost'} size="sm" onClick={() => setOpen(true)}>
                    {check.status === 'none' ? 'Add' : check.status === 'rejected' ? 'Upload again' : 'Replace'}
                </Button>
            )}
            {open && check.status === 'verified' && (
                <p className="text-xs text-gray-500">Replacing a verified document sends it for review again.</p>
            )}
        </div>
    );
}

/** Settings: the user's ID checks, why one was not accepted, and re-uploading. */
export default function IdentitySection() {
    const { user } = useAuth();
    const { showToast } = useToast();
    const { identity, isLoading, submitPan, submitGovId } = useIdentity();

    if (isLoading) {
        return (
            <div className="bg-black/70 backdrop-blur-sm border border-white/10 rounded-2xl p-6 mb-6 flex justify-center">
                <div className="animate-spin w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full" />
            </div>
        );
    }
    if (!identity) return null;

    // The government ID matters to venue owners; show it to anyone who already has one too.
    const showGovId = (user && isVenueOwner(user)) || identity.govId.status !== 'none';
    const typeLabel = GOV_ID_TYPES.find(t => t.value === identity.govId.type)?.label || null;

    const done = (close: () => void) => (result: SubmitResult) => {
        if (result.ok) {
            close();
            showToast('Submitted - we will review it shortly', 'success');
        }
        return result;
    };

    return (
        <div className="bg-black/70 backdrop-blur-sm border border-white/10 rounded-2xl p-6 mb-6">
            <h2 className="text-xl font-semibold text-white mb-1 flex items-center gap-2">
                <svg className="w-5 h-5 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                Identity Verification
            </h2>
            <p className="text-sm text-gray-400 mb-5">Checked by the FIRA team to keep payouts safe.</p>
            <div className="grid gap-4 md:grid-cols-2">
                <CheckCard
                    title="PAN"
                    purpose="Needed before your event earnings can be paid out."
                    check={identity.pan}
                    renderForm={(close) => (
                        <PanForm onCancel={close} onSubmit={async (n, p) => done(close)(await submitPan(n, p))} />
                    )}
                />
                {showGovId && (
                    <CheckCard
                        title="Government ID"
                        purpose="Needed before your venues can be approved."
                        check={identity.govId}
                        typeLabel={typeLabel}
                        renderForm={(close) => (
                            <GovIdForm onCancel={close} onSubmit={async (t, n, p) => done(close)(await submitGovId(t, n, p))} />
                        )}
                    />
                )}
            </div>
        </div>
    );
}
