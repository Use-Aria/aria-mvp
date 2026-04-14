/**
 * Universities confirmed to use Canvas LMS, with their Canvas base domains.
 * Used by UniversityPicker (profile screen) and the Open Canvas button (tools screen).
 *
 * To add a new school: append an entry, keep the array sorted by name.
 */
export interface University {
  name: string
  canvasDomain: string
}

export const UNIVERSITIES: University[] = [
  { name: 'Arizona State University',          canvasDomain: 'canvas.asu.edu' },
  { name: 'Boston College',                    canvasDomain: 'bostoncollege.instructure.com' },
  { name: 'Brown University',                  canvasDomain: 'canvas.brown.edu' },
  { name: 'Carnegie Mellon University',        canvasDomain: 'canvas.cmu.edu' },
  { name: 'Case Western Reserve University',   canvasDomain: 'canvas.case.edu' },
  { name: 'Columbia University',               canvasDomain: 'canvas.columbia.edu' },
  { name: 'Cornell University',                canvasDomain: 'canvas.cornell.edu' },
  { name: 'Dartmouth College',                 canvasDomain: 'canvas.dartmouth.edu' },
  { name: 'Duke University',                   canvasDomain: 'canvas.duke.edu' },
  { name: 'Emory University',                  canvasDomain: 'canvas.emory.edu' },
  { name: 'Florida State University',          canvasDomain: 'canvas.fsu.edu' },
  { name: 'Georgetown University',             canvasDomain: 'georgetown.instructure.com' },
  { name: 'Georgia Institute of Technology',   canvasDomain: 'gatech.instructure.com' },
  { name: 'Harvard University',                canvasDomain: 'canvas.harvard.edu' },
  { name: 'Indiana University',                canvasDomain: 'iu.instructure.com' },
  { name: 'Johns Hopkins University',          canvasDomain: 'jhu.instructure.com' },
  { name: 'MIT',                               canvasDomain: 'canvas.mit.edu' },
  { name: 'New York University',               canvasDomain: 'nyu.instructure.com' },
  { name: 'Northwestern University',           canvasDomain: 'canvas.northwestern.edu' },
  { name: 'Notre Dame',                        canvasDomain: 'canvas.nd.edu' },
  { name: 'Ohio State University',             canvasDomain: 'osu.instructure.com' },
  { name: 'Oregon State University',           canvasDomain: 'canvas.oregonstate.edu' },
  { name: 'Penn State University',             canvasDomain: 'canvas.psu.edu' },
  { name: 'Princeton University',              canvasDomain: 'canvas.princeton.edu' },
  { name: 'Purdue University',                 canvasDomain: 'purdue.instructure.com' },
  { name: 'Rice University',                   canvasDomain: 'rice.instructure.com' },
  { name: 'Stanford University',               canvasDomain: 'canvas.stanford.edu' },
  { name: 'Tufts University',                  canvasDomain: 'canvas.tufts.edu' },
  { name: 'Tulane University',                 canvasDomain: 'tulane.instructure.com' },
  { name: 'UC Berkeley',                       canvasDomain: 'bcourses.berkeley.edu' },
  { name: 'UC Davis',                          canvasDomain: 'canvas.ucdavis.edu' },
  { name: 'UC San Diego',                      canvasDomain: 'canvas.ucsd.edu' },
  { name: 'UC Santa Barbara',                  canvasDomain: 'ucsb.instructure.com' },
  { name: 'UCLA',                              canvasDomain: 'bruinlearn.ucla.edu' },
  { name: 'University of Arizona',             canvasDomain: 'canvas.arizona.edu' },
  { name: 'University of Colorado Boulder',    canvasDomain: 'canvas.colorado.edu' },
  { name: 'University of Florida',             canvasDomain: 'ufl.instructure.com' },
  { name: 'University of Illinois',            canvasDomain: 'canvas.illinois.edu' },
  { name: 'University of Maryland',            canvasDomain: 'umd.instructure.com' },
  { name: 'University of Michigan',            canvasDomain: 'umich.instructure.com' },
  { name: 'University of Minnesota',           canvasDomain: 'canvas.umn.edu' },
  { name: 'University of Oregon',              canvasDomain: 'canvas.uoregon.edu' },
  { name: 'University of Pennsylvania',        canvasDomain: 'canvas.upenn.edu' },
  { name: 'University of Texas at Austin',     canvasDomain: 'utexas.instructure.com' },
  { name: 'University of Utah',                canvasDomain: 'utah.instructure.com' },
  { name: 'University of Virginia',            canvasDomain: 'canvas.virginia.edu' },
  { name: 'University of Washington',          canvasDomain: 'canvas.uw.edu' },
  { name: 'University of Wisconsin–Madison',   canvasDomain: 'canvas.wisc.edu' },
  { name: 'USC',                               canvasDomain: 'usc.instructure.com' },
  { name: 'Vanderbilt University',             canvasDomain: 'vanderbilt.instructure.com' },
  { name: 'Wake Forest University',            canvasDomain: 'wakeforest.instructure.com' },
  { name: 'Yale University',                   canvasDomain: 'yale.instructure.com' },
]

/** Returns the Canvas base URL (https://...) for a given university name, or null if unknown. */
export function canvasDomainForUniversity(name: string | null): string | null {
  if (!name) return null
  const match = UNIVERSITIES.find(
    (u) => u.name.toLowerCase() === name.toLowerCase().trim()
  )
  return match ? `https://${match.canvasDomain}` : null
}
